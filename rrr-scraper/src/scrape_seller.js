/**
 * scrape_seller.js — Extract seller profile data from an rrr.lt seller page.
 *
 * Extracts: name, logo, address, phone, country, description,
 *           working hours, car makes list, seller sh ID.
 *
 * Usage:
 *   node src/scrape_seller.js https://rrr.lt/jonusas
 *   node src/scrape_seller.js https://rrr.lt/jonusas --out sellers/jonusas.json
 */

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import * as cheerio from 'cheerio';

const DAYS_LT = ['Pirm', 'Antr', 'Treč', 'Ketv', 'Penk', 'Šešt', 'Sekm'];
const DAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseWorkingHours($) {
  const hours = {};
  $('.scrap_time li').each((_, el) => {
    const text  = $(el).text().replace(/\s+/g, ' ').trim();
    const space = text.indexOf(' ');
    const label = space === -1 ? text : text.slice(0, space);
    const time  = space === -1 ? ''   : text.slice(space + 1);
    const idx   = DAYS_LT.findIndex(d => label.startsWith(d));
    if (idx !== -1) hours[DAYS_EN[idx]] = time;
  });
  return hours;
}

function parseSeller(html, url) {
  const $ = cheerio.load(html);

  const name        = $("[data-testid='scrap-title']").text().trim();
  const logo        = $('.scrap_logo img').attr('src') || '';
  const contacts    = $("[data-testid='scrap-contacts'] li");
  const address     = contacts.eq(0).text().trim();
  const phone       = $("[data-testid='scrap-phone']").text().trim();
  const country     = $("[data-testid='scrap-country']").text().trim();
  const description = $("[data-testid='scrap-description']").text().replace(/\s+/g, ' ').trim();

  const workingHours = parseWorkingHours($);

  const makes = [];
  $('.custom_scrap .cat_options__items a').each((_, el) => makes.push($(el).text().trim()));

  const shMatch   = html.match(/[?&]sh=(\d+)/);
  const seller_id = shMatch ? shMatch[1] : '';

  return { url, seller_id, name, logo, address, phone, country, description, working_hours: workingHours, makes };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values: argv, positionals } = parseArgs({
  options: {
    out: { type: 'string', default: '' },
  },
  allowPositionals: true,
  strict: false,
});

const sellerUrl = positionals[0];
if (!sellerUrl) {
  console.error('Usage: node src/scrape_seller.js <URL> [--out FILE]');
  process.exit(1);
}

const normalised = sellerUrl.replace(/\/+$/, '');
const slug       = normalised.split('/').pop();
const outPath    = argv.out || `sellers/${slug}.json`;

// ── Fetch & parse ─────────────────────────────────────────────────────────────

console.log(`Fetching ${normalised} …`);

const res = await fetch(normalised, { headers: HEADERS, redirect: 'follow' });
if (!res.ok) {
  console.error(`HTTP ${res.status} — cannot fetch ${normalised}`);
  process.exit(1);
}

const html = await res.text();
const data = parseSeller(html, normalised);

console.log(`Name:      ${data.name}`);
console.log(`Seller ID: ${data.seller_id}`);
console.log(`Address:   ${data.address}`);
console.log(`Phone:     ${data.phone}`);
console.log(`Country:   ${data.country}`);
console.log(`Makes:     ${data.makes.join(', ')}`);

const outDir = dirname(outPath);
if (outDir && outDir !== '.') mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
console.log(`\nSaved → ${outPath}`);
