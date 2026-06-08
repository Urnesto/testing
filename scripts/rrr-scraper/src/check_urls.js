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

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function slugPath(url) {
  try { return new URL(url).pathname.replace(/\/+$/, ''); }
  catch { return String(url).replace(/\/+$/, ''); }
}

function fullUrl(slug) {
  if (!slug) return null;
  if (slug.startsWith('http')) return slug;
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
const t0 = Date.now();

for (const part of data) {
  queue.add(async () => {
    if (_stop) return;

    const url = fullUrl(part.slug);
    if (!url) {
      part.url_valid = false;
      done++;
      return;
    }

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res   = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      part.url_valid = slugPath(res.url) === slugPath(url);
    } catch {
      part.url_valid = false;
    }

    done++;
    if (done % 50 === 0 || done === total) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate    = done / (elapsed || 1);
      const eta     = (total - done) / (rate || 1);
      const valid   = data.filter(p => p.url_valid === true).length;
      console.log(`  ${done}/${total} (${(done / total * 100).toFixed(1)}%) | ${rate.toFixed(1)}/s | ETA ${eta.toFixed(0)}s | valid: ${valid}`);
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
