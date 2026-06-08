# rrr-scraper-node

Production-grade parallel scraper for [rrr.lt](https://rrr.lt) auto parts. Node.js ESM port of `fetch_parts.py`.

## Scripts

| Script | Description |
|---|---|
| `fetch_parts.js` | Main scraper — collect all parts for a seller |
| `scrape_seller.js` | Extract seller profile (name, phone, address, makes, hours) |
| `check_urls.js` | Validate part slug URLs — detect discontinued/moved products |
| `probe_rate.js` | Find the request rate threshold before getting 429s |

## Features

- **Dual-mode routing** — automatically switches to category mode (`sub_sub_categories_keys.txt`) when a search returns ≥ 10 000 rows; uses simple page loop otherwise
- **Fast HTTP path** — undici connection pool, 20+ concurrent requests, no browser overhead
- **Browser fallback** — Playwright tab pool when Cloudflare blocks the HTTP path
- **Adaptive concurrency** — halves on 5 consecutive errors, recovers +1 per 10 successes
- **Image enrichment** — post-scrape pass fetches each part's detail page and populates `images: []` from JSON-LD
- **Proxy rotation** — optional round-robin proxy pool for image enrichment (`--proxy`)
- **Checkpoint / resume** — atomic writes; safe to kill and restart at any time
- **JSONL live writes** — data is saved to disk as each page is scraped, not held in memory
- **Graceful shutdown** — `Ctrl+C` flushes checkpoint before exiting

## Requirements

- Node.js ≥ 20
- Chrome or Chromium installed (for browser fallback)

## Install

```bash
cd scripts/rrr-scraper-node
npm install
npx playwright install chromium   # only needed for browser mode
```

---

## fetch_parts.js

Main scraper. Collects all parts listings for a seller, writes JSONL live, then enriches every part with images.

```bash
node src/fetch_parts.js [options]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--seller URL` | — | Seller profile URL (e.g. `https://rrr.lt/egidijusparts`). Fetches the page, extracts the seller's `sh` ID automatically. |
| `--name FOLDER` | `output/<seller-slug>` | Output directory. Overrides the default path entirely. |
| `--concurrency N` | `20` | Parallel HTTP workers or browser tabs for page scraping. |
| `--img-concurrency N` | `50` | Parallel workers for the image enrichment pass. |
| `--proxy` | off | Load proxies from `scripts/proxy/proxyscrape_premium_http_proxies.txt` and rotate them during image enrichment. |
| `--browser` | off | Skip the HTTP probe and go straight to Playwright. |
| `--cdp-url WS` | — | Connect to an existing browser via CDP WebSocket instead of launching a new one. |
| `--cf-wait N` | `0` | Seconds to pause for a human to solve a CF CAPTCHA (`0` = exit immediately). |

### Examples

```bash
# Scrape all parts for a seller
node src/fetch_parts.js --seller https://rrr.lt/egidijusparts

# With proxy rotation for image enrichment
node src/fetch_parts.js --seller https://rrr.lt/stankus --proxy

# Lower concurrency, more image workers
node src/fetch_parts.js --seller https://rrr.lt/jonusas --concurrency 10 --img-concurrency 30

# Force browser mode (skip HTTP probe)
node src/fetch_parts.js --seller https://rrr.lt/egidijusparts --browser --concurrency 5

# Resume an interrupted run — just re-run the same command
node src/fetch_parts.js --seller https://rrr.lt/egidijusparts
```

### Output

All files are written to `output/<seller-slug>/` by default.

| File | Description |
|---|---|
| `parts_data.jsonl` | One JSON object per line, written live during scraping |
| `parts_data.json` | Final JSON array (converted from JSONL after scraping completes) |
| `parts_checkpoint.json` | Page-level resume state (simple mode) |
| `parts_category_checkpoint.json` | Category-level resume state (category mode) |

### Part object shape

```json
{
  "id": "12345",
  "name": "Stabdžių diskas",
  "price": 29.99,
  "slug": "/dalis/12345-stabdziu-diskas",
  "images": [
    "https://rrr.lt/images/parts/12345/1.jpg"
  ]
}
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All pages fetched successfully |
| `1` | Fatal error |
| `2` | Finished with some permanently failed pages |
| `3` | Cloudflare CAPTCHA — run again with `--browser --cf-wait 120` |

---

## scrape_seller.js

Fetches a seller's profile page and extracts structured data: name, logo, address, phone, country, description, working hours, car makes list, and the internal `sh` seller ID.

```bash
node src/scrape_seller.js <URL> [--out FILE]
```

### Options

| Option | Default | Description |
|---|---|---|
| `URL` | required | Seller page URL, e.g. `https://rrr.lt/jonusas` |
| `--out FILE` | `sellers/<slug>.json` | Output JSON file path |

### Examples

```bash
node src/scrape_seller.js https://rrr.lt/jonusas
node src/scrape_seller.js https://rrr.lt/stankus --out output/stankus/seller.json
```

### Output shape

```json
{
  "url": "https://rrr.lt/jonusas",
  "seller_id": "42",
  "name": "Jonusas UAB",
  "logo": "https://rrr.lt/images/logos/jonusas.jpg",
  "address": "Vilnius, Lithuania",
  "phone": "+370 600 00000",
  "country": "Lithuania",
  "description": "Naudotų automobilių dalys…",
  "working_hours": {
    "monday": "8:00–18:00",
    "tuesday": "8:00–18:00",
    "saturday": "9:00–14:00"
  },
  "makes": ["Audi", "BMW", "Ford", "Mercedes-Benz"]
}
```

---

## check_urls.js

Reads a `parts_data.json` file, follows each part's slug URL, and checks whether the final URL path matches — detecting discontinued or moved products.

```bash
node src/check_urls.js [--file PATH] [--concurrency N]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--file PATH` | `output/parts_data.json` | Parts JSON file to validate |
| `--concurrency N` | `20` | Parallel requests |

### Examples

```bash
# Validate the default output file
node src/check_urls.js

# Validate a specific seller's file
node src/check_urls.js --file output/stankus/parts_data.json

# Faster with more concurrency
node src/check_urls.js --file output/stankus/parts_data.json --concurrency 40
```

### Output

Written next to the input file:

| File | Description |
|---|---|
| `parts_data_checked.json` | All parts with `url_valid: true/false` added |
| `parts_data_invalid.json` | Only invalid parts (redirected away / not found) |

A part is **invalid** when following the slug URL redirects to a different path — meaning the product listing was removed or its URL changed.

---

## Proxies

Place a proxy list at `scripts/proxy/proxyscrape_premium_http_proxies.txt`. Supported formats (one per line):

```
user:pass@host:port
host:port:user:pass
http://user:pass@host:port
host:port
```

Pass `--proxy` to `fetch_parts.js` to enable rotation during image enrichment.

---

## Rate limit probing

Use `probe_rate.js` to find the safe request rate before hitting 429s:

```bash
node src/probe_rate.js --rate 5  --count 40
node src/probe_rate.js --rate 10 --count 60
node src/probe_rate.js --rate 15 --count 80
```

Stops on the first 429 and prints all response headers, including `Retry-After` and any `X-RateLimit-*` values.

---

## How fetch_parts.js works

```
Startup
  └─ --seller URL → fetch page → extract sh= ID
  └─ resolve output → output/<seller-slug>/

HTTP probe (page 1)
  ├─ total_rows < 10 000  → simple page loop (pages 1…N in batches)
  ├─ total_rows ≥ 10 000  → category mode   (iterate sub_sub_categories_keys.txt)
  └─ CF challenge / bad JSON → fall back to Playwright

Playwright (browser fallback)
  ├─ Session warmup on /paieska
  ├─ Probe page 1 → same dual-mode routing
  └─ Browser restart every 300 pages (memory hygiene)

Image enrichment (post-scrape)
  └─ p-queue workers → fetch detail page → extract JSON-LD images
  └─ --proxy: round-robin through proxy pool

JSONL → JSON conversion → parts_data.json
```
