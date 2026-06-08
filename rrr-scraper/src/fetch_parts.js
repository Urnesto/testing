/**
 * fetch_parts.js — Production-grade parallel scraper for rrr.lt parts.
 * Node.js ESM port of fetch_parts.py
 *
 * Fast path:  undici Pool (20+ concurrent requests, no browser overhead)
 * Slow path:  Playwright tab pool (when site requires a browser session)
 *
 * Resilience:
 *   - SIGINT/SIGTERM graceful shutdown with checkpoint flush
 *   - Atomic checkpoint writes (tmp + rename, never corrupt)
 *   - JSONL last-line repair on resume
 *   - Rate-limit aware: 429 honours Retry-After, 5xx backs off, 4xx fails fast
 *   - Jitter on all retries (prevents thundering herd)
 *   - Adaptive concurrency (auto-halves on errors, recovers gradually)
 *   - Browser restart every N pages (prevents OOM from memory leaks)
 *
 * Usage:
 *   node src/fetch_parts.js [--name FOLDER] [--concurrency N] [--browser]
 *                           [--cdp-url WS_URL] [--cf-wait SECONDS]
 */

import { Pool, ProxyAgent, setGlobalDispatcher, Agent, fetch as undiciFetch } from 'undici'
import PQueue from 'p-queue'
import * as cheerio from 'cheerio'
import { chromium } from 'playwright'
import {
  existsSync, readFileSync, writeFileSync, renameSync,
  mkdirSync, statSync, createReadStream, createWriteStream,
  unlinkSync,
} from 'fs'
import { createInterface } from 'readline'
import { parseArgs } from 'util'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const SITE_ROOT = 'https://rrr.lt'
const BASE_PATH = '/paieska'
let SEARCH_ID = '6'
let _cfCookieHeader = ''  // set after Playwright CF warmup, injected into all HTTP requests
const CATEGORY_KEYS_FILE = join(__dirname, '..', 'sub_sub_categories_keys.txt')

const MAX_RETRIES = 5
const BROWSER_RESTART_EVERY = 300

// Output paths — overridden by --name at startup (always absolute, anchored to repo root)
const _REPO_ROOT = join(__dirname, '..')
let OUTPUT_DIR = join(_REPO_ROOT, 'output')
let OUTPUT_FILE = join(_REPO_ROOT, 'output', 'parts_data.jsonl')
let OUTPUT_JSON = join(_REPO_ROOT, 'output', 'parts_data.json')
let CHECKPOINT_FILE = join(_REPO_ROOT, 'output', 'parts_checkpoint.json')
let CATEGORY_CHECKPOINT_FILE = join(_REPO_ROOT, 'output', 'parts_category_checkpoint.json')

const _UA = (
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'
)

const XHR_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  pragma: 'no-cache',
  referer: `${SITE_ROOT}${BASE_PATH}`,
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': _UA,
  'x-requested-with': 'XMLHttpRequest',
}

const DETAIL_HEADERS = {
  accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  referer: SITE_ROOT,
  'user-agent': _UA,
}

const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1920,1080',
  '--start-maximized',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--ignore-certificate-errors',
]

const STEALTH_JS = `() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { app: { isInstalled: false }, runtime: {}, loadTimes: () => {}, csi: () => {} };
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ]
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  // Spoof WebGL fingerprint — one of the top detection vectors after webdriver
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParam.call(this, param);
  };
  // Block canvas fingerprinting noise
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  const getImageData = CanvasRenderingContext2D.prototype.getImageData;
  HTMLCanvasElement.prototype.toBlob = function(...a) { return toBlob.apply(this, a); };
  HTMLCanvasElement.prototype.toDataURL = function(...a) { return toDataURL.apply(this, a); };
  // Mock permissions.query so sites can't detect headless via denied notifications
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(params);
}`

const EXIT_OK = 0
const EXIT_PARTIAL = 2
const EXIT_FATAL = 1
const EXIT_CAPTCHA = 3

// ── Proxy rotation ────────────────────────────────────────────────────────────
// Enabled only when --proxy flag is passed. Agents are initialised in main()
// after CLI args are parsed.

const _PROXY_FILE = join(__dirname, '..', 'proxy', 'proxyscrape_premium_http_proxies.txt')

let _proxyEnabled = false  // set to true only when --proxy is passed
let _proxyUrls   = []
let _proxyAgents = []
let _proxyIdx    = 0

function initProxies() {
  // Try file first, then PROXY_LIST env var (newline or comma separated)
  let raw = null
  try {
    raw = readFileSync(_PROXY_FILE, 'utf-8')
  } catch {
    if (process.env.PROXY_LIST) {
      raw = process.env.PROXY_LIST.replace(/,/g, '\n')
      logger.info('Proxy list loaded from PROXY_LIST env var.')
    } else {
      logger.warn(`Proxy file not found and PROXY_LIST env var not set — running without proxy`)
      return
    }
  }
  _proxyUrls = raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.startsWith('http') ? l : `http://${l}`)
  _proxyAgents = _proxyUrls.map(uri => new ProxyAgent({
    uri,
    headersTimeout: 30000,
    bodyTimeout:    60000,
    connectTimeout: 10000,
  }))
  _proxyEnabled = true
  const sample = _proxyUrls[0].replace(/:([^:@]+)@/, ':***@')
  logger.info(`Proxy rotation enabled — ${_proxyAgents.length} proxies (e.g. ${sample})`)
}

function nextProxyAgent() {
  if (!_proxyEnabled) return null
  return _proxyAgents[_proxyIdx++ % _proxyAgents.length]
}

// fetch() wrapper — only routes through proxy when --proxy is active
function proxyFetch(url, options = {}) {
  if (!_proxyEnabled) return fetch(url, options)
  const agent = nextProxyAgent()
  return undiciFetch(url, { ...options, dispatcher: agent })
}

// pool.request() wrapper — only routes through proxy when --proxy is active.
// AbortController timeout covers queue-wait time (undici's headersTimeout only
// starts after dispatch, so a full pool leaves requests waiting forever).
async function proxyRequest(path, headers, pool, timeoutMs = 40000) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (!_proxyEnabled) {
      return pool.request({ path, method: 'GET', headers, throwOnError: false, signal: controller.signal })
    }
    const agent = nextProxyAgent()
    return agent.request({
      origin: SITE_ROOT,
      path,
      method: 'GET',
      headers,
      throwOnError: false,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(tid)
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let _stop = false

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  if (level === 'DEBUG') return
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`${ts} ${level.padEnd(8)} ${msg}`)
}

const logger = {
  info: (m) => log('INFO', m),
  warn: (m) => log('WARNING', m),
  error: (m) => log('ERROR', m),
  debug: (m) => log('DEBUG', m),
  critical: (m) => log('CRITICAL', m),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jitter(delayMs, pct = 0.25) {
  return delayMs * (1 + (Math.random() * 2 - 1) * pct)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isValidPartsResponse(data) {
  return data !== null && typeof data === 'object' && ('parts' in data || 'total_rows' in data)
}

// ── Adaptive semaphore (wraps p-queue) ────────────────────────────────────────

// Global rate-limit cooldown — when any request gets 429, all new requests
// pause until this timestamp passes (prevents thundering-herd retries)
let _rateLimitedUntil = 0

class AdaptiveSemaphore {
  static SUCCESSES_TO_RECOVER = 10

  constructor(initial, minimum = 1) {
    this._max = initial
    this._min = minimum
    this._successes = 0
    this._queue = new PQueue({ concurrency: initial })
  }

  get current() { return this._queue.concurrency }

  recordSuccess() {
    this._successes++
    if (this._successes >= AdaptiveSemaphore.SUCCESSES_TO_RECOVER && this._queue.concurrency < this._max) {
      this._successes = 0
      this._queue.concurrency = Math.min(this._max, this._queue.concurrency + 1)
      logger.debug(`Adaptive concurrency recovered to ${this._queue.concurrency}`)
    }
  }

  recordError() {
    this._successes = 0
    if (this._queue.concurrency > this._min) {
      this._queue.concurrency = Math.max(this._min, Math.floor(this._queue.concurrency / 2))
      logger.warn(`Adaptive concurrency reduced to ${this._queue.concurrency}`)
    }
  }

  record429(retryAfterMs) {
    this._successes = 0
    // Immediately halve concurrency on rate limit
    if (this._queue.concurrency > this._min) {
      this._queue.concurrency = Math.max(this._min, Math.floor(this._queue.concurrency / 2))
      logger.warn(`Adaptive concurrency halved to ${this._queue.concurrency} (rate limited)`)
    }
    // Set global cooldown so all pending requests pause too
    _rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + retryAfterMs)
  }

  add(fn) {
    return this._queue.add(fn)
  }
}

// ── JSONL repair ──────────────────────────────────────────────────────────────

function repairJsonl(path) {
  if (!existsSync(path)) return
  if (statSync(path).size === 0) return
  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  if (!lines.length) return
  try {
    JSON.parse(lines[lines.length - 1])
  } catch {
    logger.warn(`Corrupt last line in ${path} — truncating.`)
    writeFileSync(path, lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : ''), 'utf-8')
  }
}

// ── JSONL → JSON conversion ───────────────────────────────────────────────────

async function jsonlToJson(src, dst) {
  if (!existsSync(src)) {
    logger.warn(`JSONL source ${src} not found — skipping JSON conversion.`)
    return
  }
  logger.info(`Converting ${src} → ${dst} …`)
  const tmp = dst + '.tmp'
  let count = 0
  let skipped = 0

  const out = createWriteStream(tmp, { encoding: 'utf-8' })
  const flush = () => new Promise((res, rej) => out.once('finish', res).once('error', rej))

  out.write('[\n')
  let first = true

  const rl = createInterface({ input: createReadStream(src, { encoding: 'utf-8' }), crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) continue
    try { JSON.parse(line) } catch { skipped++; continue }
    if (!first) out.write(',\n')
    out.write(line)
    first = false
    count++
  }
  out.write('\n]\n')
  out.end()
  await flush()

  renameSync(tmp, dst)
  logger.info(`Saved ${count} items to ${dst}${skipped ? ` (${skipped} corrupt lines skipped)` : ''}`)
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { done: new Set(), failed: new Set(), pagesTotal: null }
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
    return {
      done: new Set(data.done || []),
      failed: new Set(data.failed || []),
      pagesTotal: data.pages_total ?? null,
    }
  } catch (err) {
    logger.warn(`Checkpoint unreadable (${err.message}) — starting fresh.`)
    return { done: new Set(), failed: new Set(), pagesTotal: null }
  }
}

function saveCheckpoint(done, failed, pagesTotal = null) {
  const tmp = CHECKPOINT_FILE + '.tmp'
  try {
    const payload = {
      done: [...done],
      failed: [...failed],
    }
    if (pagesTotal != null) payload.pages_total = pagesTotal
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, CHECKPOINT_FILE)
  } catch (err) {
    logger.error(`Failed to save checkpoint: ${err.message}`)
  } finally {
    if (existsSync(tmp)) try { unlinkSync(tmp) } catch {}
  }
}

// ── Category checkpoint ───────────────────────────────────────────────────────

function loadCategoryCheckpoint() {
  if (!existsSync(CATEGORY_CHECKPOINT_FILE)) return { done: new Set(), failed: new Set() }
  try {
    const data = JSON.parse(readFileSync(CATEGORY_CHECKPOINT_FILE, 'utf-8'))
    return { done: new Set(data.done || []), failed: new Set(data.failed || []) }
  } catch {
    return { done: new Set(), failed: new Set() }
  }
}

function saveCategoryCheckpoint(done, failed) {
  const tmp = CATEGORY_CHECKPOINT_FILE + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify({ done: [...done], failed: [...failed] }))
    renameSync(tmp, CATEGORY_CHECKPOINT_FILE)
  } catch (err) {
    logger.error(`Failed to save category checkpoint: ${err.message}`)
  } finally {
    if (existsSync(tmp)) try { unlinkSync(tmp) } catch {}
  }
}

function loadCategoryKeys() {
  if (!existsSync(CATEGORY_KEYS_FILE)) return []
  return readFileSync(CATEGORY_KEYS_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number)
}

// Recursively collect leaf category IDs where part_count > 0.
// Leaf = node with no sub_categories (or empty). ID comes from category_id
// field when present, otherwise from the object key.
function extractLeafCategoryIds(categories, result = []) {
  for (const [key, val] of Object.entries(categories)) {
    if (!val || typeof val !== 'object') continue
    const id = val.category_id ?? parseInt(key)
    const subs = val.sub_categories
    if (subs && Object.keys(subs).length > 0) {
      extractLeafCategoryIds(subs, result)
    } else if ((val.part_count || 0) > 0 && !isNaN(id)) {
      result.push(id)
    }
  }
  return result
}

// Fetch category keys dynamically from the rrr.lt API.
// Priority: 1) categories embedded in probe response
//           2) dedicated categories endpoint
//           3) fall back to static file
async function fetchDynamicCategoryKeys(probe, pool = null) {
  // 1. Probe response may already contain the category tree
  if (probe?.categories && typeof probe.categories === 'object') {
    const ids = extractLeafCategoryIds(probe.categories)
    if (ids.length > 0) {
      logger.info(`Loaded ${ids.length} category keys from search response (part_count > 0)`)
      return ids
    }
  }

  // 2. Try dedicated endpoints if pool is available
  if (pool) {
    const paths = [
      `/paieska?sh=${SEARCH_ID}&categories=1`,
      `/api/categories?sh=${SEARCH_ID}`,
      `/api/categories`,
    ]
    for (const path of paths) {
      try {
        const res = await pool.request({ path, method: 'GET', headers: XHR_HEADERS, throwOnError: false })
        if (res.statusCode !== 200) { await res.body.dump(); continue }
        const text = await readBodyText(res)
        const data = JSON.parse(text)
        const cats = data.categories ?? data
        if (cats && typeof cats === 'object') {
          const ids = extractLeafCategoryIds(cats)
          if (ids.length > 0) {
            logger.info(`Loaded ${ids.length} category keys from ${path} (part_count > 0)`)
            return ids
          }
        }
      } catch (e) {
        logger.debug(`Category endpoint ${path} failed: ${e.message}`)
      }
    }
  }

  // 3. Fall back to static file
  const fileKeys = loadCategoryKeys()
  if (fileKeys.length > 0) {
    logger.info(`Loaded ${fileKeys.length} category keys from static file (fallback)`)
    return fileKeys
  }

  logger.error('No category keys available — cannot run category mode.')
  return []
}

// ── Signal handling ───────────────────────────────────────────────────────────

function registerSignals() {
  const handler = (sig) => {
    if (_stop) return
    _stop = true
    logger.warn(`Received ${sig} — shutting down gracefully…`)
    // Force exit if cleanup takes too long
    setTimeout(() => { logger.error('Forced exit after timeout.'); process.exit(1) }, 8000).unref()
  }
  process.on('SIGINT', () => handler('SIGINT'))
  process.on('SIGTERM', () => handler('SIGTERM'))
}

// ── URL builder ───────────────────────────────────────────────────────────────

function pageUrlPath(pageNum, cpc = null) {
  const pagePart = pageNum > 1 ? `&page=${pageNum}` : ''
  const cpcPart = cpc != null ? `&cpc=${cpc}` : ''
  return `${BASE_PATH}?sh=${SEARCH_ID}${pagePart}${cpcPart}`
}

// ── Body decompression ────────────────────────────────────────────────────────
// undici pool.request() never decompresses automatically — must handle manually

async function readBodyText(res) {
  const encoding = (res.headers['content-encoding'] || '').toLowerCase()
  const buf = Buffer.from(await res.body.arrayBuffer())
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(buf).toString('utf-8')
    if (encoding === 'deflate') return inflateSync(buf).toString('utf-8')
    if (encoding === 'br') return brotliDecompressSync(buf).toString('utf-8')
  } catch (e) {
    logger.debug(`Body decompression error (${encoding}): ${e.message}`)
  }
  return buf.toString('utf-8')
}

// ── CF response classification ────────────────────────────────────────────────

function classifyCf(statusCode, headers, bodyText = '') {
  const isCf = 'cf-ray' in headers || (headers['server'] || '').toLowerCase() === 'cloudflare'
  if (!isCf) return 'ok'
  const body = bodyText.slice(0, 4000).toLowerCase()
  if (['cf-turnstile', 'cf-challenge-running', 'managed-challenge'].some(m => body.includes(m))) return 'captcha'
  if (['just a moment', 'cf-browser-verification', 'challenge-platform', 'jschl'].some(m => body.includes(m))) return 'js_challenge'
  if ([403, 503].includes(statusCode)) return 'block'
  return 'ok'
}

// ── HTTP page fetch ───────────────────────────────────────────────────────────

async function fetchPageHttp(pool, pageNum, sem, cpc = null) {
  return sem.add(async () => {
    if (_stop) return null

    let delay = 1000

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (_stop) return null

      // Respect global rate-limit cooldown before sending any request
      const cooldown = _rateLimitedUntil - Date.now()
      if (cooldown > 0) await sleep(cooldown)

      let res = null
      try {
        const reqHeaders = _cfCookieHeader
          ? { ...XHR_HEADERS, cookie: _cfCookieHeader }
          : XHR_HEADERS
        res = await proxyRequest(pageUrlPath(pageNum, cpc), reqHeaders, pool)

        if (!res) {
          // Bun's undici compat returns undefined — treat as transient failure
          logger.warn(`Page ${pageNum}: no response from pool (attempt ${attempt})`)
          sem.recordError()
          await sleep(jitter(delay))
          delay = Math.min(delay * 2, 120000)
          continue
        }

        const { statusCode, headers } = res

        if (statusCode === 200) {
          // Always read as text first so CF HTML can be detected even when Content-Type says JSON
          const text = await readBodyText(res)
          const cf = classifyCf(statusCode, headers, text)
          if (cf === 'js_challenge') throw new Error('CF_JS_CHALLENGE')
          if (cf === 'captcha') throw new Error('CF_CAPTCHA')
          if (cf === 'block') { sem.recordError(); throw new Error('CF_BLOCK') }

          let data
          try { data = JSON.parse(text) } catch {
            logger.warn(`Page ${pageNum}: malformed JSON (attempt ${attempt})`)
            await sleep(jitter(delay))
            delay = Math.min(delay * 2, 60000)
            continue
          }
          if (!isValidPartsResponse(data)) {
            logger.debug(`Page ${pageNum}: JSON missing expected keys`)
            return null
          }
          sem.recordSuccess()
          return data

        } else if (statusCode === 429) {
          const retryAfterMs = parseFloat(res.headers['retry-after'] || '60') * 1000
          await res.body.dump()
          logger.warn(`Page ${pageNum}: 429 — waiting ${retryAfterMs / 1000}s (attempt ${attempt})`)
          sem.record429(retryAfterMs)
          await sleep(jitter(retryAfterMs))
          continue

        } else if ([403, 503].includes(statusCode)) {
          const text = await readBodyText(res)
          const cf = classifyCf(statusCode, headers, text)
          if (cf === 'js_challenge') throw new Error('CF_JS_CHALLENGE')
          if (cf === 'captcha') throw new Error('CF_CAPTCHA')
          if (cf === 'block') { sem.recordError(); throw new Error('CF_BLOCK') }
          if (statusCode === 403) { logger.error(`Page ${pageNum}: permanent 403`); return null }
          logger.warn(`Page ${pageNum}: 503 (attempt ${attempt})`)
          sem.recordError()
          await sleep(jitter(delay))
          delay = Math.min(delay * 2, 120000)
          continue

        } else if ([502, 504].includes(statusCode)) {
          await res.body.dump()
          logger.warn(`Page ${pageNum}: ${statusCode} (attempt ${attempt})`)
          sem.recordError()
          await sleep(jitter(delay))
          delay = Math.min(delay * 2, 120000)
          continue

        } else if (statusCode >= 400 && statusCode < 500) {
          await res.body.dump()
          logger.error(`Page ${pageNum}: permanent HTTP ${statusCode}`)
          return null

        } else {
          await res.body.dump()
          logger.warn(`Page ${pageNum}: unexpected ${statusCode} (attempt ${attempt})`)
          sem.recordError()
          await sleep(jitter(delay))
          delay = Math.min(delay * 2, 60000)
          continue
        }

      } catch (err) {
        // Re-throw CF signals so callers can handle them
        if (['CF_JS_CHALLENGE', 'CF_CAPTCHA', 'CF_BLOCK'].includes(err.message)) throw err

        // Try to drain body if still attached
        if (res) try { await res.body.dump() } catch {}

        logger.warn(`Page ${pageNum}: ${err.constructor.name}: ${err.message} (attempt ${attempt})`)
        sem.recordError()
        if (attempt < MAX_RETRIES) {
          await sleep(jitter(delay))
          delay = Math.min(delay * 2, 120000)
        }
      }
    }

    logger.error(`Page ${pageNum}: all ${MAX_RETRIES} attempts exhausted`)
    return null
  })
}

// ── Image enrichment ──────────────────────────────────────────────────────────

let IMG_CONCURRENCY = 50

function extractImagesFromHtml(html) {
  const $ = cheerio.load(html)
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(el).html() || '{}')
      if (data['@type'] === 'Product') {
        const imgs = data.image
        return Array.isArray(imgs) ? imgs : (imgs ? [imgs] : [])
      }
    } catch {}
  }
  return []
}

function validateImageUrls(images) {
  return images.filter(img => {
    if (typeof img !== 'string' || !img) return false
    try { return new URL(img).protocol.startsWith('http') } catch { return false }
  })
}

function normaliseSlug(slug) {
  if (!slug) return null
  const full = slug.startsWith('http') ? slug : SITE_ROOT + (slug.startsWith('/') ? '' : '/') + slug
  try { return new URL(full).href } catch { return null }
}

// Stronger CF check — catches "Just a moment" 200 OK challenge pages that classifyCf misses
function isCfChallengePage(text) {
  const snip = text.slice(0, 6000).toLowerCase()
  return (
    snip.includes('just a moment') ||
    snip.includes('cf-browser-verification') ||
    snip.includes('challenge-platform') ||
    snip.includes('cf-turnstile') ||
    snip.includes('managed-challenge') ||
    snip.includes('jschl')
  )
}

// Return value: { images: string[], cfBlocked: bool }
async function fetchImageUrls(slug, imgHeaders, imgPool, maxRetries = 2) {
  let delay = 200
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = new URL(slug)
      const res = await proxyRequest(url.pathname + url.search, imgHeaders, imgPool)

      if (!res) {
        // pool returned undefined (Bun compat) — fallback via proxyFetch (proxy-aware)
        const fetchRes = await proxyFetch(slug, { headers: imgHeaders })
        if (!fetchRes.ok) return { images: [], cfBlocked: [403, 503].includes(fetchRes.status) }
        const text = await fetchRes.text()
        if (isCfChallengePage(text)) return { images: [], cfBlocked: true }
        return { images: validateImageUrls(extractImagesFromHtml(text)), cfBlocked: false }
      }

      if (res.statusCode === 200) {
        const text = await readBodyText(res)
        if (isCfChallengePage(text)) return { images: [], cfBlocked: true }
        return { images: validateImageUrls(extractImagesFromHtml(text)), cfBlocked: false }
      }

      await res.body.dump()

      if (res.statusCode === 429) {
        // Cap at 8s — images are best-effort, don't stall the queue long
        const retryAfterMs = Math.min(parseFloat(res.headers['retry-after'] || '8') * 1000, 8000)
        logger.debug(`image 429 — retry-after ${retryAfterMs / 1000}s (attempt ${attempt})`)
        if (attempt < maxRetries) await sleep(jitter(retryAfterMs))
        continue
      }

      if ([403, 503].includes(res.statusCode)) {
        return { images: [], cfBlocked: true }
      }

      if (res.statusCode >= 500) {
        logger.debug(`image ${res.statusCode} (attempt ${attempt}) — ${slug.slice(-60)}`)
        if (attempt < maxRetries) { await sleep(jitter(delay)); delay = Math.min(delay * 2, 3000) }
        continue
      }

      // 4xx (non-429/403) — permanent failure, no retry
      return { images: [], cfBlocked: false }
    } catch (err) {
      logger.debug(`image fetch error (attempt ${attempt}): ${err.message}`)
      if (attempt < maxRetries) { await sleep(jitter(delay)); delay = Math.min(delay * 2, 3000) }
    }
  }
  return { images: [], cfBlocked: false }
}

async function enrichJsonlWithImages(concurrency = IMG_CONCURRENCY, forceReEnrich = false) {
  logger.info(`Image enrichment pass: reading ${OUTPUT_FILE}…`)
  if (!existsSync(OUTPUT_FILE)) return

  // Stream-parse JSONL to avoid loading the whole file into RAM
  const parts = []
  {
    const rl = createInterface({ input: createReadStream(OUTPUT_FILE, { encoding: 'utf-8' }), crlfDelay: Infinity })
    for await (const raw of rl) {
      const line = raw.trim()
      if (!line) continue
      try { parts.push(JSON.parse(line)) } catch {}
    }
  }

  if (forceReEnrich) {
    for (const part of parts) delete part.images
    logger.info(`Force re-enrich: cleared images on ${parts.length} parts`)
  }

  // ── Deduplication: group part indices by normalised slug ──────────────────
  // Parts sharing a slug fetch once and share results — often 30-50% fewer requests.
  const slugToIndices = new Map()
  let alreadyDone = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.images !== undefined) { alreadyDone++; continue }  // resume: already enriched

    const slug = normaliseSlug(part.slug)
    if (!slug) { part.images = []; continue }

    if (!slugToIndices.has(slug)) slugToIndices.set(slug, [])
    slugToIndices.get(slug).push(i)
  }

  const uniqueSlugs = [...slugToIndices.keys()]
  logger.info(
    `${uniqueSlugs.length} unique slugs to fetch (${parts.length} parts, ${alreadyDone} already enriched, concurrency=${concurrency})…` +
    (_proxyAgents.length ? ` [proxy: ${_proxyAgents.length} agents]` : '')
  )

  let fetched = 0
  let noImages = 0
  let cfBlocks = 0
  const imgT0 = Date.now()

  if (uniqueSlugs.length > 0) {
    const imgPool = new Pool(SITE_ROOT, {
      connections: concurrency + 10,
      pipelining: 2,
      headersTimeout: 12000,
      bodyTimeout:   15000,
      connectTimeout: 8000,
    })
    const imgHeaders = _cfCookieHeader
      ? { ...DETAIL_HEADERS, cookie: _cfCookieHeader }
      : DETAIL_HEADERS

    const queue = new PQueue({ concurrency })
    const logEvery = Math.max(1, Math.floor(uniqueSlugs.length / 20))
    const saveEvery = 400
    let cfWarnedAt = 0
    let lastSavedAt = 0

    function flushEnrichedParts() {
      const tmp = OUTPUT_FILE + '.tmp'
      try {
        writeFileSync(tmp, parts.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8')
        renameSync(tmp, OUTPUT_FILE)
        logger.info(`Image checkpoint saved (${fetched}/${uniqueSlugs.length} fetched) → ${OUTPUT_FILE}`)
      } catch (err) {
        logger.warn(`Image checkpoint flush failed: ${err.message}`)
      }
    }

    try {
      await Promise.all(uniqueSlugs.map(slug => queue.add(async () => {
        if (_stop) return

        const { images, cfBlocked } = await fetchImageUrls(slug, imgHeaders, imgPool)

        if (cfBlocked) {
          cfBlocks++
          if (cfBlocks - cfWarnedAt >= 50) {
            cfWarnedAt = cfBlocks
            logger.warn(`CF blocking image requests: ${cfBlocks} so far — consider passing --browser or refreshing --cf-wait`)
            queue.concurrency = Math.max(5, Math.floor(queue.concurrency / 2))
            logger.warn(`Image concurrency reduced to ${queue.concurrency} due to CF blocks`)
          }
        } else if (!images.length) {
          noImages++
        }

        if (fetched === Math.floor(uniqueSlugs.length * 0.1) && (noImages + cfBlocks) / Math.max(1, fetched) > 0.4) {
          const reduced = Math.max(5, Math.floor(queue.concurrency * 0.6))
          if (reduced < queue.concurrency) {
            queue.concurrency = reduced
            logger.warn(`High empty rate (${((noImages + cfBlocks) / fetched * 100).toFixed(0)}%) — reducing image concurrency to ${queue.concurrency}`)
          }
        }

        for (const idx of slugToIndices.get(slug)) {
          parts[idx].images = images
        }

        fetched++

        if (fetched - lastSavedAt >= saveEvery) {
          lastSavedAt = fetched
          flushEnrichedParts()
        }

        if (fetched % logEvery === 0 || fetched === uniqueSlugs.length) {
          const pct = (fetched / uniqueSlugs.length * 100).toFixed(0)
          const elapsed = (Date.now() - imgT0) / 1000
          const rate = fetched / (elapsed || 1)
          const eta = (uniqueSlugs.length - fetched) / (rate || 1)
          logger.info(
            `Images: ${fetched}/${uniqueSlugs.length} (${pct}%) | ${rate.toFixed(1)}/s | ETA ${(eta / 60).toFixed(1)}m` +
            (cfBlocks ? ` | cf_blocked=${cfBlocks}` : '') +
            (noImages ? ` | no_images=${noImages}` : '')
          )
        }
      })))
    } finally {
      try { await imgPool.destroy() } catch {}
    }
  }

  const tmp = OUTPUT_FILE + '.tmp'
  writeFileSync(tmp, parts.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8')
  renameSync(tmp, OUTPUT_FILE)
  const imgElapsed = (Date.now() - imgT0) / 1000
  const imgRate = uniqueSlugs.length / (imgElapsed || 1)
  const withImages = parts.filter(p => p.images?.length > 0).length
  logger.info(
    `Image enrichment done — ${uniqueSlugs.length} slugs in ${imgElapsed.toFixed(1)}s (${imgRate.toFixed(1)}/s) | ` +
    `with_images=${withImages} no_images=${noImages} cf_blocked=${cfBlocks} total_parts=${parts.length} → ${OUTPUT_FILE}`
  )
}

// ── Simple HTTP run (total_rows < 10 000) ─────────────────────────────────────

async function runHttpSimple(pool, sem, probe, pagesTotal, concurrency) {
  const { done, failed, pagesTotal: savedTotal } = loadCheckpoint()

  if (savedTotal && savedTotal !== pagesTotal) {
    logger.warn(`pages_total changed ${savedTotal}→${pagesTotal} — trimming checkpoint.`)
    for (const p of [...done]) if (p > pagesTotal) done.delete(p)
    for (const p of [...failed]) if (p > pagesTotal) failed.delete(p)
  }

  const appendMode = existsSync(OUTPUT_FILE) && done.size > 0
  const outStream = createWriteStream(OUTPUT_FILE, { flags: appendMode ? 'a' : 'w', encoding: 'utf-8' })
  const writePart = (part) => outStream.write(JSON.stringify(part) + '\n')

  if (!done.has(1)) {
    for (const part of (probe.parts || [])) writePart(part)
    done.add(1)
  }

  const remaining = []
  for (let p = 2; p <= pagesTotal; p++) {
    if (!done.has(p) && !failed.has(p)) remaining.push(p)
  }
  logger.info(`${remaining.length} pages remaining | ${done.size} done | ${failed.size} permanently failed`)

  const thisRunFailed = new Set()
  const t0 = Date.now()
  const logEvery = Math.max(1, Math.floor(remaining.length / 20))
  let completed = 0

  // Dispatch all pages at once — the semaphore controls concurrency.
  // No outer batch loop means no tail-latency stall between batches.
  await Promise.allSettled(remaining.map(pageNum => fetchPageHttp(pool, pageNum, sem).then(
    value => {
      if (!value) { thisRunFailed.add(pageNum); return }
      for (const part of (value.parts || [])) writePart(part)
      done.add(pageNum)
      thisRunFailed.delete(pageNum)

      completed++
      if (completed % logEvery === 0 || completed === remaining.length) {
        saveCheckpoint(done, new Set([...failed, ...thisRunFailed]), pagesTotal)
        const elapsed = (Date.now() - t0) / 1000
        const rate = done.size / (elapsed || 1)
        const eta = (pagesTotal - done.size) / rate
        logger.info(
          `${done.size}/${pagesTotal} (${(done.size / pagesTotal * 100).toFixed(1)}%) | ` +
          `${rate.toFixed(1)} p/s | ETA ${(eta / 60).toFixed(0)}m | ` +
          `concurrency=${sem.current} | failed=${failed.size + thisRunFailed.size}`
        )
      }
    },
    err => {
      if (err?.message === 'CF_CAPTCHA') {
        logger.critical('CF CAPTCHA mid-run — saving and exiting.')
        outStream.end()
        saveCheckpoint(done, new Set([...failed, ...thisRunFailed]), pagesTotal)
        process.exit(EXIT_CAPTCHA)
      }
      thisRunFailed.add(pageNum)
    }
  )))

  // Second-pass retry of this-run failures
  if (thisRunFailed.size > 0 && !_stop) {
    logger.info(`Second-pass retry: ${thisRunFailed.size} pages…`)
    await sleep(jitter(10000))
    const retrySem = new AdaptiveSemaphore(Math.max(1, Math.floor(sem.current / 4)), 1)
    const retryResults = await Promise.allSettled(
      [...thisRunFailed].map(p => fetchPageHttp(pool, p, retrySem))
    )
    for (let j = 0; j < [...thisRunFailed].length; j++) {
      const pageNum = [...thisRunFailed][j]
      const r = retryResults[j]
      if (r.status === 'fulfilled' && r.value) {
        for (const part of (r.value.parts || [])) writePart(part)
        done.add(pageNum)
        thisRunFailed.delete(pageNum)
      } else {
        failed.add(pageNum)
      }
    }
    saveCheckpoint(done, failed, pagesTotal)
  }

  outStream.end()
  await new Promise(res => outStream.once('finish', res).once('close', res))

  if (!_stop && existsSync(OUTPUT_FILE)) {
    await enrichJsonlWithImages(IMG_CONCURRENCY)
  }
  return true
}

// ── CF cookie refresh via Playwright ─────────────────────────────────────────

async function refreshCfCookies(cfContext) {
  logger.info('Solving CF JS challenge via browser…')
  const pg = await cfContext.newPage()
  try {
    await pg.goto(SITE_ROOT + BASE_PATH, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // Wait until the CF challenge page is gone (title changes from "Just a moment")
    await pg.waitForFunction(
      () => !document.title.toLowerCase().includes('just a moment') &&
             !document.querySelector('#challenge-form') &&
             !document.querySelector('cf-challenge-running'),
      { timeout: 45000, polling: 500 }
    ).catch(() => logger.debug('CF challenge wait timed out — proceeding anyway'))

    const cookies = await cfContext.cookies()
    const cfClearance = cookies.find(c => c.name === 'cf_clearance')
    if (cfClearance) {
      _cfCookieHeader = `cf_clearance=${cfClearance.value}`
      logger.info('cf_clearance injected into HTTP requests.')
    } else {
      logger.debug('No cf_clearance cookie found after browser challenge.')
    }
  } finally {
    await pg.close().catch(() => {})
  }
}

// ── HTTP run — entry point (probes, routes to simple or category mode) ─────────

async function runHttp(concurrency, captchaWaitS = 0, cfContext = null) {
  const { done } = loadCheckpoint()
  if (done.size > 0) repairJsonl(OUTPUT_FILE)

  const sem = new AdaptiveSemaphore(concurrency, 5)

  const pool = new Pool(SITE_ROOT, {
    connections: concurrency + 5,
    pipelining: 2,
    headersTimeout: 30000,
    bodyTimeout: 60000,
    connectTimeout: 10000,
  })

  try {
    // ── Probe page 1 ────────────────────────────────────────────────────────
    logger.info('Probing page 1 via HTTP…')
    let probe
    try {
      probe = await fetchPageHttp(pool, 1, sem)
    } catch (err) {
      if (err.message === 'CF_CAPTCHA') {
        logger.critical('CF CAPTCHA on page 1 — cannot continue. Use --browser.')
        process.exit(EXIT_CAPTCHA)
      }
      if (['CF_JS_CHALLENGE', 'CF_BLOCK'].includes(err.message)) {
        if (cfContext) {
          await refreshCfCookies(cfContext)
          try {
            probe = await fetchPageHttp(pool, 1, sem)
          } catch (err2) {
            logger.info(`CF retry failed (${err2.message}) — switching to Playwright.`)
            return false
          }
        } else {
          logger.info('CF challenge on probe — switching to Playwright.')
          return false
        }
      } else {
        throw err
      }
    }

    if (!probe) {
      if (cfContext) {
        logger.info('HTTP probe returned nothing — trying CF warmup and retrying…')
        await refreshCfCookies(cfContext)
        try { probe = await fetchPageHttp(pool, 1, sem) } catch { probe = null }
        if (!probe) {
          logger.info('HTTP probe still failing after CF warmup — switching to Playwright.')
          return false
        }
      } else {
        logger.info('HTTP probe returned nothing — switching to Playwright.')
        return false
      }
    }

    const pagesTotal = probe.pages_total || 1
    const totalRows = probe.total_rows || 0
    logger.info(`pages_total=${pagesTotal}  total_rows=${totalRows}`)

    // Proactive CF warmup — detail pages are CF-protected even when the search API isn't.
    // Without cf_clearance, 70-80% of image enrichment requests get 403/redirect.
    if (cfContext && !_cfCookieHeader) {
      logger.info('Proactive CF warmup for image enrichment…')
      await refreshCfCookies(cfContext)
    }

    // ── Normal mode ──────────────────────────────────────────────────────────
    if (!(typeof totalRows === 'number' && totalRows >= 10_000)) {
      logger.info(`total_rows=${totalRows} < 10000 — scraping ${pagesTotal} pages normally.`)
      return await runHttpSimple(pool, sem, probe, pagesTotal, concurrency)
    }

    // ── Category mode (total_rows ≥ 10 000) ──────────────────────────────────
    logger.info(`total_rows=${totalRows} ≥ 10000 — switching to category mode.`)

    const categoryKeys = await fetchDynamicCategoryKeys(probe, pool)
    if (!categoryKeys.length) {
      process.exit(EXIT_FATAL)
    }

    const { done: doneCpcs, failed: failedCpcs } = loadCategoryCheckpoint()
    const remainingCpcs = categoryKeys.filter(c => !doneCpcs.has(c) && !failedCpcs.has(c))
    logger.info(`${remainingCpcs.length} categories remaining | ${doneCpcs.size} done | ${failedCpcs.size} failed`)

    const appendMode = existsSync(OUTPUT_FILE) && (doneCpcs.size > 0 || failedCpcs.size > 0)
    const outStream = createWriteStream(OUTPUT_FILE, { flags: appendMode ? 'a' : 'w', encoding: 'utf-8' })
    const writePart = (part) => outStream.write(JSON.stringify(part) + '\n')

    for (let catIdx = 0; catIdx < remainingCpcs.length; catIdx++) {
      if (_stop) { logger.info(`Shutdown — stopping before cpc=${remainingCpcs[catIdx]}.`); break }

      const cpc = remainingCpcs[catIdx]
      logger.info(`cpc=${cpc} (${catIdx + 1}/${remainingCpcs.length}): probing page 1…`)

      let catProbe
      try {
        catProbe = await fetchPageHttp(pool, 1, sem, cpc)
      } catch (err) {
        if (err.message === 'CF_CAPTCHA') {
          logger.critical(`CF CAPTCHA on cpc=${cpc} — exiting.`)
          saveCategoryCheckpoint(doneCpcs, failedCpcs)
          outStream.end()
          process.exit(EXIT_CAPTCHA)
        }
        if (['CF_JS_CHALLENGE', 'CF_BLOCK'].includes(err.message)) {
          logger.info(`CF challenge on cpc=${cpc} — switching to Playwright.`)
          saveCategoryCheckpoint(doneCpcs, failedCpcs)
          outStream.end()
          return false
        }
        catProbe = null
      }

      if (!catProbe) {
        logger.warn(`cpc=${cpc}: probe returned nothing — skipping.`)
        failedCpcs.add(cpc)
        saveCategoryCheckpoint(doneCpcs, failedCpcs)
        continue
      }

      const catTotalRows = catProbe.total_rows || 0
      if (!catTotalRows) {
        logger.info(`cpc=${cpc}: empty category — skipping.`)
        doneCpcs.add(cpc)
        saveCategoryCheckpoint(doneCpcs, failedCpcs)
        continue
      }

      const catPagesTotal = Math.max(1, catProbe.pages_total || 1)
      logger.info(`cpc=${cpc}: pages=${catPagesTotal} rows=${catTotalRows}`)

      // Write page 1 immediately — no image blocking
      for (const part of (catProbe.parts || [])) writePart(part)

      const remainingPages = Array.from({ length: catPagesTotal - 1 }, (_, i) => i + 2)
      let pagesDone = 1
      const t0 = Date.now()
      const catLogEvery = Math.max(1, Math.floor(remainingPages.length / 10))

      await Promise.allSettled(remainingPages.map(p => fetchPageHttp(pool, p, sem, cpc).then(
        value => {
          if (!value) return
          for (const part of (value.parts || [])) writePart(part)
          pagesDone++
          if (pagesDone % catLogEvery === 0 || pagesDone === catPagesTotal) {
            const elapsed = (Date.now() - t0) / 1000
            const rate = pagesDone / (elapsed || 1)
            const eta = (catPagesTotal - pagesDone) / rate
            logger.info(
              `cpc=${cpc} | ${pagesDone}/${catPagesTotal} (${(pagesDone / catPagesTotal * 100).toFixed(1)}%) | ` +
              `${rate.toFixed(1)} p/s | ETA ${(eta / 60).toFixed(0)}m`
            )
          }
        },
        err => {
          if (err?.message === 'CF_CAPTCHA') {
            logger.critical(`CF CAPTCHA mid-run on cpc=${cpc} — exiting.`)
            saveCategoryCheckpoint(doneCpcs, failedCpcs)
            outStream.end()
            process.exit(EXIT_CAPTCHA)
          }
        }
      )))

      doneCpcs.add(cpc)
      saveCategoryCheckpoint(doneCpcs, failedCpcs)
    }

    outStream.end()
    await new Promise(res => outStream.once('finish', res).once('close', res))

    // Image enrichment after all categories scraped
    if (!_stop && existsSync(OUTPUT_FILE)) {
      await enrichJsonlWithImages(IMG_CONCURRENCY)
    }

    return true

  } finally {
    try { await pool.destroy() } catch {}
  }
}

// ── Playwright helpers ────────────────────────────────────────────────────────

async function makeFreshPage(context) {
  const pg = await context.newPage()
  await pg.addInitScript(STEALTH_JS)
  await pg.setExtraHTTPHeaders(XHR_HEADERS)
  return pg
}

async function waitCfChallenge(pg, timeoutS = 45, captchaWaitS = 0) {
  const deadline = Date.now() + timeoutS * 1000
  while (Date.now() < deadline) {
    let title = ''
    let content = ''
    try { title = (await pg.title()).toLowerCase() } catch { return }
    try { content = await pg.content() } catch { return }
    if (['cf-turnstile', 'cf-challenge-running', 'managed-challenge'].some(m => content.includes(m))) {
      if (captchaWaitS > 0) {
        logger.critical(`CF CAPTCHA — pausing ${captchaWaitS}s for human to solve…`)
        await sleep(captchaWaitS * 1000)
        try {
          if (!(await pg.title()).toLowerCase().includes('just a moment')) return
        } catch { return }
      }
      throw new Error('CF_CAPTCHA')
    }
    if (!title.includes('just a moment')) return
    await sleep(2000)
  }
  logger.warn(`CF JS challenge did not resolve within ${timeoutS}s`)
}

async function fetchPagePlaywright(pg, pageNum, captchaWaitS = 0, cpc = null) {
  let captured = null

  const handleResponse = async (response) => {
    try {
      if (response.status() !== 200) return
      let data
      try { data = await response.json() } catch { return }
      if (isValidPartsResponse(data)) captured = data
    } catch {}
  }
  pg.on('response', handleResponse)

  try {
    await sleep(jitter(2000))
    await pg.goto(`${SITE_ROOT}${pageUrlPath(pageNum, cpc)}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await waitCfChallenge(pg, 45, captchaWaitS)
    await sleep(jitter(1000))

    if (!captured) {
      // SSR fallback: search inline scripts and window globals
      try {
        const ssr = await pg.evaluate(`
          (() => {
            for (const el of document.querySelectorAll('script:not([src])')) {
              const text = el.textContent.trim()
              try { const d = JSON.parse(text); if (d && ('parts' in d || 'total_rows' in d)) return d } catch(e) {}
              const m = text.match(/=\\s*(\\{[\\s\\S]*?"(?:parts|total_rows)"[\\s\\S]*?\\})\\s*[;,]?\\s*$/)
              if (m) { try { const d = JSON.parse(m[1]); if (d && ('parts' in d || 'total_rows' in d)) return d } catch(e) {} }
            }
            for (const k of ['__PRELOADED_STATE__','__INITIAL_STATE__','__NEXT_DATA__','serverData','pageData']) {
              const v = window[k]
              if (v && ('parts' in v || 'total_rows' in v)) return v
            }
            return null
          })()
        `)
        if (ssr && isValidPartsResponse(ssr)) captured = ssr
      } catch {}
    }
  } catch (err) {
    if (err.message === 'CF_CAPTCHA') throw err
    logger.warn(`Page ${pageNum}: goto failed — ${err.message}`)
  } finally {
    pg.off('response', handleResponse)
  }

  return captured
}

// ── Playwright run ────────────────────────────────────────────────────────────

async function runPlaywright(concurrency, cdpUrl, captchaWaitS = 0) {
  const { done, failed, pagesTotal: savedTotal } = loadCheckpoint()
  if (done.size > 0) repairJsonl(OUTPUT_FILE)

  let browser, context

  if (cdpUrl) {
    browser = await chromium.connectOverCDP(cdpUrl)
    context = browser.contexts()[0] || await browser.newContext()
  } else {
    for (const channel of ['chrome', 'chromium', null]) {
      try {
        browser = await chromium.launch({
          headless: true,
          args: BROWSER_ARGS,
          ...(channel ? { channel } : {}),
        })
        logger.info(`Browser launched (channel=${channel || 'bundled-chromium'}).`)
        break
      } catch {}
    }
    if (!browser) { logger.error('Failed to launch any browser.'); process.exit(EXIT_FATAL) }
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: _UA,
      extraHTTPHeaders: XHR_HEADERS,
    })
  }

  // Session warmup
  try {
    logger.info(`Warming up session on ${SITE_ROOT}${BASE_PATH}…`)
    const pg = await makeFreshPage(context)
    try {
      await pg.goto(`${SITE_ROOT}${BASE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
      await waitCfChallenge(pg, 45, captchaWaitS)
      await sleep(jitter(2000))
      await pg.evaluate('window.scrollBy(0, document.body.scrollHeight * 0.3)')
      await sleep(jitter(1000))
    } finally { await pg.close() }
    logger.info('Session warmup complete.')
  } catch (err) {
    if (err.message === 'CF_CAPTCHA') {
      logger.critical('CF CAPTCHA during warmup — cannot continue unattended.')
      if (!cdpUrl) await browser.close()
      process.exit(EXIT_CAPTCHA)
    }
    logger.warn(`Session warmup failed (non-fatal): ${err.message}`)
  }

  // Probe page 1
  const pilot = await makeFreshPage(context)
  let probe
  try {
    probe = await fetchPagePlaywright(pilot, 1, captchaWaitS)
  } catch (err) {
    if (err.message === 'CF_CAPTCHA') {
      logger.critical('CF CAPTCHA on page 1 — cannot continue unattended.')
      await pilot.close()
      if (!cdpUrl) await browser.close()
      process.exit(EXIT_CAPTCHA)
    }
    probe = null
  } finally { await pilot.close() }

  if (!probe) {
    logger.error('Could not capture data from page 1 — aborting.')
    if (!cdpUrl) await browser.close()
    process.exit(EXIT_FATAL)
  }

  const pagesTotal = probe.pages_total || 1
  const totalRows = probe.total_rows || 0
  logger.info(`pages_total=${pagesTotal}  total_rows=${totalRows}`)

  // ── Helper: run one page via a fresh browser tab with retry ──────────────
  async function runPageInTab(pageNum, cpc, checkpointFn) {
    let pg = await makeFreshPage(context)
    let result = null
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (_stop) return null
        try {
          result = await fetchPagePlaywright(pg, pageNum, captchaWaitS, cpc)
          break
        } catch (err) {
          if (err.message === 'CF_CAPTCHA') {
            logger.critical('CF CAPTCHA mid-run — saving and exiting.')
            if (checkpointFn) checkpointFn()
            process.exit(EXIT_CAPTCHA)
          }
          logger.warn(`Page ${pageNum}${cpc != null ? ` cpc=${cpc}` : ''}: tab error — ${err.message} (attempt ${attempt})`)
          try { await pg.close() } catch {}
          if (attempt < 3) {
            try { pg = await makeFreshPage(context) } catch { break }
          }
        }
      }
    } finally {
      try { await pg.close() } catch {}
    }
    return result
  }

  // ── Browser restart — called between batches only (never inside concurrent tasks) ──
  let pagesSinceRestart = 0
  async function restartBrowserIfNeeded(pagesInBatch) {
    if (cdpUrl) return
    pagesSinceRestart += pagesInBatch
    if (pagesSinceRestart >= BROWSER_RESTART_EVERY) {
      logger.info(`Restarting browser after ${pagesSinceRestart} pages (memory hygiene)…`)
      try { await browser.close() } catch {}
      browser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
      context = await browser.newContext({ userAgent: _UA, extraHTTPHeaders: XHR_HEADERS })
      pagesSinceRestart = 0
      logger.info('Browser restarted.')
    }
  }

  // ── Category mode (total_rows >= 10 000) ─────────────────────────────────
  if (totalRows >= 10_000) {
    logger.info(`total_rows=${totalRows} ≥ 10000 — switching to category mode (browser).`)

    const categoryKeys = await fetchDynamicCategoryKeys(probe)
    if (!categoryKeys.length) {
      if (!cdpUrl) await browser.close()
      process.exit(EXIT_FATAL)
    }

    const { done: doneCpcs, failed: failedCpcs } = loadCategoryCheckpoint()
    const remainingCpcs = categoryKeys.filter(c => !doneCpcs.has(c) && !failedCpcs.has(c))
    logger.info(`${remainingCpcs.length} categories remaining | ${doneCpcs.size} done | ${failedCpcs.size} failed`)

    const appendMode = existsSync(OUTPUT_FILE) && (doneCpcs.size > 0 || failedCpcs.size > 0)
    const outStream = createWriteStream(OUTPUT_FILE, { flags: appendMode ? 'a' : 'w', encoding: 'utf-8' })
    const writePart = (part) => outStream.write(JSON.stringify(part) + '\n')
    const tabQueue = new PQueue({ concurrency })

    for (let catIdx = 0; catIdx < remainingCpcs.length; catIdx++) {
      if (_stop) { logger.info(`Shutdown — stopping before cpc=${remainingCpcs[catIdx]}.`); break }

      const cpc = remainingCpcs[catIdx]
      logger.info(`cpc=${cpc} (${catIdx + 1}/${remainingCpcs.length}): probing page 1…`)

      const catProbe = await runPageInTab(1, cpc, () => saveCategoryCheckpoint(doneCpcs, failedCpcs))
      await restartBrowserIfNeeded(1)

      if (!catProbe) {
        logger.warn(`cpc=${cpc}: probe returned nothing — skipping.`)
        failedCpcs.add(cpc)
        saveCategoryCheckpoint(doneCpcs, failedCpcs)
        continue
      }

      const catTotalRows = catProbe.total_rows || 0
      if (!catTotalRows) {
        logger.info(`cpc=${cpc}: empty category — skipping.`)
        doneCpcs.add(cpc)
        saveCategoryCheckpoint(doneCpcs, failedCpcs)
        continue
      }

      const catPagesTotal = Math.max(1, catProbe.pages_total || 1)
      logger.info(`cpc=${cpc}: pages=${catPagesTotal} rows=${catTotalRows}`)

      for (const part of (catProbe.parts || [])) writePart(part)

      const remainingPages = Array.from({ length: catPagesTotal - 1 }, (_, i) => i + 2)
      let pagesDone = 1
      const t0 = Date.now()
      const batchSize = concurrency * 2

      for (let i = 0; i < remainingPages.length; i += batchSize) {
        if (_stop) break
        const chunk = remainingPages.slice(i, i + batchSize)

        await Promise.all(chunk.map(pageNum => tabQueue.add(async () => {
          if (_stop) return
          const result = await runPageInTab(pageNum, cpc, () => saveCategoryCheckpoint(doneCpcs, failedCpcs))
          if (result) {
            for (const part of (result.parts || [])) writePart(part)
            pagesDone++
          }
        })))

        // Restart between batches — all tabs are idle, no race possible
        await restartBrowserIfNeeded(chunk.length)

        const elapsed = (Date.now() - t0) / 1000
        const rate = pagesDone / (elapsed || 1)
        const eta = (catPagesTotal - pagesDone) / rate
        logger.info(
          `cpc=${cpc} | ${pagesDone}/${catPagesTotal} (${(pagesDone / catPagesTotal * 100).toFixed(1)}%) | ` +
          `${rate.toFixed(1)} p/s | ETA ${(eta / 60).toFixed(0)}m`
        )
      }

      doneCpcs.add(cpc)
      saveCategoryCheckpoint(doneCpcs, failedCpcs)
    }

    outStream.end()
    await new Promise(res => outStream.once('finish', res).once('close', res))
    if (!cdpUrl) try { await browser.close() } catch {}
    if (!_stop && existsSync(OUTPUT_FILE)) await enrichJsonlWithImages(IMG_CONCURRENCY)
    return
  }

  // ── Simple page loop (total_rows < 10 000) ────────────────────────────────

  if (savedTotal && savedTotal !== pagesTotal) {
    logger.warn(`pages_total changed ${savedTotal}→${pagesTotal} — trimming checkpoint.`)
    for (const p of [...done]) if (p > pagesTotal) done.delete(p)
    for (const p of [...failed]) if (p > pagesTotal) failed.delete(p)
  }

  const outStream = createWriteStream(OUTPUT_FILE, { flags: done.size > 0 ? 'a' : 'w', encoding: 'utf-8' })
  const writePart = (part) => outStream.write(JSON.stringify(part) + '\n')

  if (!done.has(1)) {
    for (const part of (probe.parts || [])) writePart(part)
    done.add(1)
  }

  const remaining = []
  for (let p = 2; p <= pagesTotal; p++) {
    if (!done.has(p) && !failed.has(p)) remaining.push(p)
  }
  logger.info(`${remaining.length} pages remaining (browser mode)`)

  const batchSize = concurrency * 2
  const tabQueue = new PQueue({ concurrency })
  const t0 = Date.now()

  for (let i = 0; i < remaining.length; i += batchSize) {
    if (_stop) { logger.info('Shutdown — flushing checkpoint…'); break }
    const chunk = remaining.slice(i, i + batchSize)

    await Promise.all(chunk.map(pageNum => tabQueue.add(async () => {
      if (_stop) return
      const result = await runPageInTab(pageNum, null, () => saveCheckpoint(done, failed, pagesTotal))
      if (result) {
        for (const part of (result.parts || [])) writePart(part)
        done.add(pageNum)
        failed.delete(pageNum)
      } else {
        failed.add(pageNum)
        logger.warn(`Page ${pageNum} permanently failed (browser mode)`)
      }
    })))

    // Restart between batches — all tabs are idle, no race possible
    await restartBrowserIfNeeded(chunk.length)

    saveCheckpoint(done, failed, pagesTotal)
    const elapsed = (Date.now() - t0) / 1000
    const rate = done.size / (elapsed || 1)
    const eta = (pagesTotal - done.size) / rate
    logger.info(
      `${done.size}/${pagesTotal} (${(done.size / pagesTotal * 100).toFixed(1)}%) | ` +
      `${rate.toFixed(1)} p/s | ETA ${(eta / 60).toFixed(0)}m | failed=${failed.size}`
    )
  }

  outStream.end()
  await new Promise(res => outStream.once('finish', res).once('close', res))
  if (!cdpUrl) try { await browser.close() } catch {}
  if (!_stop && existsSync(OUTPUT_FILE)) await enrichJsonlWithImages(IMG_CONCURRENCY)
}

// ── Seller URL → sh ID resolution ────────────────────────────────────────────

// Global cache lives next to the script so it persists across all runs/folders
const _SELLER_CACHE_FILE = join(__dirname, '.seller_cache.json')

function _loadSellerCache() {
  try { return JSON.parse(readFileSync(_SELLER_CACHE_FILE, 'utf-8')) } catch { return {} }
}
function _saveSellerCache(cache) {
  try { writeFileSync(_SELLER_CACHE_FILE, JSON.stringify(cache, null, 2)) } catch {}
}

async function resolveSellerShId(sellerUrl) {
  // Check global cache first
  const cache = _loadSellerCache()
  if (cache[sellerUrl]) {
    logger.info(`Seller sh ID from cache: ${cache[sellerUrl]}`)
    return cache[sellerUrl]
  }

  logger.info(`Resolving seller sh ID from ${sellerUrl}…`)

  // Try plain HTTP fetch first
  let html = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await proxyFetch(sellerUrl, {
      headers: {
        'user-agent': _UA,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        referer: SITE_ROOT,
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      },
    })
    if (res.status === 429 || res.status === 403) {
      logger.warn(`Seller page ${res.status} on attempt ${attempt} — falling back to Playwright`)
      break
    }
    if (!res.ok) throw new Error(`Seller page returned HTTP ${res.status}`)
    html = await res.text()
    break
  }

  // Fall back to Playwright if HTTP is rate-limited — use DOM API to get href directly
  if (!html) {
    logger.info('Using Playwright to fetch seller page (HTTP rate-limited)…')
    let browser
    for (const channel of ['chrome', 'chromium', null]) {
      try {
        const opts = { headless: true, args: BROWSER_ARGS }
        if (channel) opts.channel = channel
        browser = await chromium.launch(opts)
        break
      } catch {}
    }
    if (!browser) throw new Error('Could not launch browser to fetch seller page')
    const context = await browser.newContext({ userAgent: _UA })
    const page = await context.newPage()
    try {
      await page.goto(sellerUrl, { waitUntil: 'networkidle', timeout: 30000 })
      // Wait for the seller filter button and get href directly from DOM
      const locator = page.locator('[data-testid="seller-filter-button"]')
      await locator.waitFor({ timeout: 15000 })
      const href = await locator.getAttribute('href') || ''
      const m = href.match(/[?&]sh=(\d+)/)
      if (m) {
        logger.info(`Seller sh ID resolved via Playwright DOM: ${m[1]}`)
        cache[sellerUrl] = m[1]
        _saveSellerCache(cache)
        await browser.close().catch(() => {})
        return m[1]
      }
      // Last resort: scan full page source
      html = await page.content()
    } finally {
      await browser.close().catch(() => {})
    }
  }

  const shMatch = (html || '').match(/[?&]sh=(\d+)/)
  if (!shMatch) throw new Error(`Could not find sh= on ${sellerUrl} — check the URL`)
  const shParam = shMatch[1]
  logger.info(`Seller sh ID resolved: ${shParam}`)

  cache[sellerUrl] = shParam
  _saveSellerCache(cache)

  return shParam
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const _mainT0 = Date.now()
  const { values: args } = parseArgs({
    options: {
      name: { type: 'string', default: '' },
      seller: { type: 'string', default: '' },
      concurrency: { type: 'string', default: '20' },
      'img-concurrency': { type: 'string', default: '0' },
      browser: { type: 'boolean', default: false },
      proxy: { type: 'boolean', default: false },
      'cdp-url': { type: 'string', default: '' },
      'cf-wait': { type: 'string', default: '0' },
      'enrich-only': { type: 'boolean', default: false },
      'force-re-enrich': { type: 'boolean', default: false },
    },
    strict: false,
  })

  const concurrency = parseInt(args.concurrency, 10) || 20
  IMG_CONCURRENCY = parseInt(args['img-concurrency'], 10) || IMG_CONCURRENCY
  const cdpUrl = args['cdp-url'] || null
  const forceBrowser = args.browser
  const captchaWaitS = parseInt(args['cf-wait'], 10) || 0

  if (args.proxy) {
    initProxies()
  } else {
    logger.info('Proxy disabled (no --proxy flag) — using direct connections')
  }

  // Resolve seller sh ID if --seller is provided
  const sellerUrl = args.seller || ''
  if (sellerUrl) {
    SEARCH_ID = await resolveSellerShId(sellerUrl)
  }

  // Derive output dir from --name, or fall back to seller slug under output/, or 'output'
  let name = args.name
  if (!name) {
    if (sellerUrl) {
      const slug = new URL(sellerUrl).pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'seller'
      name = slug
    } else {
      name = 'output'
    }
  }

  // Set output paths from --name — always absolute so CWD shifts can't break writes
  const nameAbs = join(_REPO_ROOT, name)
  OUTPUT_DIR = nameAbs
  OUTPUT_FILE = join(nameAbs, 'parts_data.jsonl')
  OUTPUT_JSON = join(nameAbs, 'parts_data.json')
  CHECKPOINT_FILE = join(nameAbs, 'parts_checkpoint.json')
  CATEGORY_CHECKPOINT_FILE = join(nameAbs, 'parts_category_checkpoint.json')
  mkdirSync(OUTPUT_DIR, { recursive: true })

  if (args['enrich-only']) {
    registerSignals()
    logger.info(`Enrich-only mode${args['force-re-enrich'] ? ' (force re-enrich)' : ''} → ${OUTPUT_FILE}`)
    await enrichJsonlWithImages(IMG_CONCURRENCY, args['force-re-enrich'])
    await jsonlToJson(OUTPUT_FILE, OUTPUT_JSON)
    process.exit(EXIT_OK)
  }

  registerSignals()

  try {
    if (!forceBrowser) {
      logger.info(`Trying fast HTTP mode (concurrency=${concurrency})…`)

      // Launch a CF-solver browser before HTTP mode — mirrors Python's approach.
      // If the probe gets a CF JS challenge, this browser navigates to the page,
      // auto-solves it, and injects cf_clearance into all subsequent HTTP requests.
      let cfBrowser = null
      let cfContext = null
      for (const channel of ['chrome', 'chromium', null]) {
        try {
          const opts = { headless: true, args: BROWSER_ARGS }
          if (channel) opts.channel = channel
          cfBrowser = await chromium.launch(opts)
          cfContext = await cfBrowser.newContext({
            viewport: { width: 1920, height: 1080 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            userAgent: _UA,
          })
          logger.info(`CF-solver browser launched (channel=${channel ?? 'bundled'}).`)
          break
        } catch (e) {
          logger.info(`CF-solver launch failed (channel=${channel}): ${e.message}`)
        }
      }
      if (!cfContext) {
        logger.warn('Could not launch CF-solver browser — image enrichment will run without CF cookies (some images may be blocked by CF).')
      }

      const ok = await runHttp(concurrency, captchaWaitS, cfContext)

      if (cfBrowser) {
        try { await cfBrowser.close() } catch {}
      }

      if (!ok) {
        if (!cfContext) {
          logger.warn('HTTP mode failed and no browser available — cannot continue.')
          process.exit(EXIT_FATAL)
        }
        logger.info(`HTTP mode unavailable — switching to Playwright (concurrency=${concurrency})…`)
        await runPlaywright(concurrency, cdpUrl, captchaWaitS)
      }
    } else {
      await runPlaywright(concurrency, cdpUrl, captchaWaitS)
    }

    const { failed } = loadCheckpoint()
    await jsonlToJson(OUTPUT_FILE, OUTPUT_JSON)

    const totalElapsed = (Date.now() - _mainT0) / 1000
    const mm = Math.floor(totalElapsed / 60)
    const ss = (totalElapsed % 60).toFixed(1)
    logger.info(`\n── BENCHMARK SUMMARY ──────────────────────────────────────────`)
    logger.info(`  Runtime   : ${mm}m ${ss}s total`)
    logger.info(`  Engine    : Node.js (undici pool, p-queue, cheerio)`)
    logger.info(`  Concurrency: ${concurrency} (scrape) / ${IMG_CONCURRENCY} (images)`)
    logger.info(`───────────────────────────────────────────────────────────────`)

    if (failed.size > 0) {
      logger.warn(`Finished with ${failed.size} permanently failed pages: ${[...failed].sort((a, b) => a - b)}`)
      process.exit(EXIT_PARTIAL)
    }

    logger.info(`All pages fetched successfully → ${OUTPUT_JSON}`)
    process.exit(EXIT_OK)

  } catch (err) {
    logger.error(`Fatal error: ${err.stack || err.message}`)
    process.exit(EXIT_FATAL)
  }
}

main()
