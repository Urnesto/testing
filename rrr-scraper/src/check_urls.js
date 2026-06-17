/**
 * check_urls.js — Validate slug URLs in a parts JSON file.
 *
 * Valid   = final URL path after redirect matches the slug.
 * Invalid = redirected away (product no longer exists / URL changed).
 *
 * Usage:
 *   node src/check_urls.js                                         # uses output/parts_data.json
 *   node src/check_urls.js --file output/stankus/parts_data.json
 *   node src/check_urls.js --file parts.json --concurrency 30
 *
 * Output (written next to the input file):
 *   parts_data_checked.json  — all checked parts with url_valid field added
 *   parts_data_invalid.json  — only invalid parts
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

import PQueue from 'p-queue';

const { values: argv } = parseArgs({
  options: {
    file:        { type: 'string', default: 'output/parts_data.json' },
    concurrency: { type: 'string', default: '20' },
  },
  allowPositionals: true,
});

const FILE        = argv.file;
const CONCURRENCY = parseInt(argv.concurrency, 10) || 20;
const TIMEOUT_MS  = 15_000;
const SITE_ROOT   = 'https://rrr.lt';
const REQUEST_DELAY_MS = 100; // 100ms delay = ~10 requests/second

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugPath(url) {
  try { return new URL(url).pathname.replace(/\/+$/, ''); }
  catch { return String(url).replace(/\/+$/, ''); }
}

function fullUrl(slug) {
  if (!slug) return null;
  // Already a full URL
  if (slug.startsWith('http://') || slug.startsWith('https://')) return slug;
  // Relative path
  return SITE_ROOT + (slug.startsWith('/') ? '' : '/') + slug;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let _stop = false;
process.on('SIGINT',  () => { _stop = true; console.log('\nStopping… saving progress.'); });
process.on('SIGTERM', () => { _stop = true; });

// ── Load input ────────────────────────────────────────────────────────────────

let data;
try {
  data = JSON.parse(readFileSync(FILE, 'utf-8'));
} catch (err) {
  console.error(`ERROR: cannot read ${FILE}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(data)) {
  console.error('ERROR: expected a JSON array at top level.');
  process.exit(1);
}

const total = data.length;
console.log(`Reading ${FILE}…`);
console.log(`${total} parts to check (concurrency=${CONCURRENCY})`);

// ── Check loop ────────────────────────────────────────────────────────────────

const queue = new PQueue({ concurrency: CONCURRENCY });
let done = 0;
let rateLimited = 0;
const t0 = Date.now();

for (const part of data) {
  queue.add(async () => {
    if (_stop) return;

    // Add delay to avoid rate limiting
    await sleep(REQUEST_DELAY_MS);

    const url = fullUrl(part.slug);
    if (!url) {
      part.url_valid = false;
      done++;
      return;
    }

    try {
      let lastError = null;
      let res = null;

      // Retry loop for 429 rate limiting
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const ctrl  = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
          res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: ctrl.signal });
          clearTimeout(timer);

          // If we got rate limited, retry with exponential backoff
          if (res.status === 429 && attempt < MAX_RETRIES) {
            rateLimited++;
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
            await sleep(delay);
            continue;
          }

          // Success or non-retryable status, break out
          break;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
          }
        }
      }

      // If all retries failed, mark invalid
      if (!res) {
        part.url_valid = false;
        done++;
        return;
      }

      // Valid = no redirect (200) OR redirect to same path (trailing slash normalization)
      if (res.status === 200) {
        part.url_valid = true;
      } else if (res.status >= 301 && res.status <= 308) {
        // Redirected - check if it's just trailing slash or same path
        const location = res.headers.get('location') ?? '';
        if (!location) {
          part.url_valid = false;
        } else {
          const dest = new URL(location, url).href;
          const origPath = slugPath(url);
          const destPath = slugPath(dest);
          // Valid if paths match (e.g., /path -> /path/)
          part.url_valid = origPath === destPath;
        }
      } else {
        // 404, 403, 500, 429 (after retries), etc. = invalid
        part.url_valid = false;
      }
    } catch {
      part.url_valid = false;
    }

    done++;
    if (done % 50 === 0 || done === total) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate    = done / (elapsed || 1);
      const eta     = (total - done) / (rate || 1);
      const valid   = data.filter(p => p.url_valid === true).length;
      const rlMsg   = rateLimited > 0 ? ` | rate-limited: ${rateLimited}` : '';
      console.log(`  ${done}/${total} (${(done / total * 100).toFixed(1)}%) | ${rate.toFixed(1)}/s | ETA ${eta.toFixed(0)}s | valid: ${valid}${rlMsg}`);
    }
  });
}

await queue.onIdle();

// ── Save results ──────────────────────────────────────────────────────────────

const { dir, name, ext } = parsePath(FILE);
const checked     = data.filter(p => 'url_valid' in p);
const invalid     = checked.filter(p => !p.url_valid);
const validCount  = checked.length - invalid.length;

if (checked.length > 0) {
  const outAll = join(dir || '.', `${name}_checked${ext}`);
  writeFileSync(outAll, JSON.stringify(checked, null, 2), 'utf-8');
  console.log(`\nSaved all checked → ${outAll}`);

  if (invalid.length > 0) {
    const outInvalid = join(dir || '.', `${name}_invalid${ext}`);
    writeFileSync(outInvalid, JSON.stringify(invalid, null, 2), 'utf-8');
    console.log(`Saved invalid only → ${outInvalid}  (${invalid.length} items)`);
  }
}

console.log(`\nDone — valid: ${validCount}, invalid: ${invalid.length}, checked: ${done}/${total}`);
if (rateLimited > 0) {
  console.log(`\n⚠️  Rate limited ${rateLimited} times. Consider reducing concurrency (--concurrency 5) or adding delays.`);
}
