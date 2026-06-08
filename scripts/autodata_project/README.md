# autodata_project

A dual-purpose scraping toolkit for automotive data:

1. **Car specifications** — crawls [auto-data.net](https://www.auto-data.net) for full vehicle specs (brand → model → generation → variant → specs table)
2. **Seller contacts** — scrapes [rrr.lt](https://rrr.lt) marketplace for auto-parts seller contact info
3. **Post-processing** — deduplication, country grouping by phone prefix

## Project structure

```
autodata_project/
├── spiders/
│   ├── autodata_spider.py     # auto-data.net specs crawler (Scrapy)
│   └── rrr_seller_spider.py   # rrr.lt seller contact scraper (Scrapy + Playwright)
├── scraper.py                 # standalone Playwright seller scraper (Ovoko/rrr.lt)
├── sort_by_country.py         # group sellers by country from phone prefix
├── run_rrr_seller.py          # launcher script for rrr_seller spider
├── items.py                   # Scrapy item definitions
└── settings.py                # Scrapy project settings
```

## Requirements

```bash
pip install scrapy scrapy-playwright playwright httpx beautifulsoup4
playwright install chromium
```

---

## Spiders

### autodata_spider — Car specifications

Crawls `www.auto-data.net` through a 5-level hierarchy and extracts full spec tables for every car variant.

```
Brand list → Brand page → Model page → Generation page → Car detail → Specs table
```

```bash
cd scripts
scrapy crawl autodata -o cars.json
```

**Output files:**
- `cars.json` — all scraped cars grouped by brand, auto-saved every 100 items
- `skipped.json` — URLs that were skipped with reasons

**Each car record:**
```json
{
  "brand": "BMW",
  "model": "3 Series",
  "generation": "E46 (1998–2005)",
  "specs": {
    "Engine": "2.0 L",
    "Power": "150 hp",
    "Torque": "200 Nm",
    "0–100 km/h": "9.2 s"
  }
}
```

Imperial values are automatically converted to metric.

---

### rrr_seller_spider — Seller contacts (Scrapy + Playwright)

Scrapes rrr.lt for seller contact information across all product categories. Uses Playwright for browser automation (32 concurrent pages) to handle dynamic content and seller info modals.

```
Category accordion → Category pages → Product pages → Seller modal → Contact info
```

```bash
# From the project root
python scripts/autodata_project/run_rrr_seller.py

# Or directly with Scrapy
cd scripts
scrapy crawl rrr_seller -o rrr_seller_scrapy.json
```

**Output:** `rrr_seller_scrapy.json` — one record per seller with:
- `name`, `phone`, `email`, `address`
- company registration details
- link to the seller's rrr.lt listing page

---

## scraper.py — Standalone Playwright scraper

An alternative async Playwright scraper for rrr.lt/Ovoko sellers. Opens product pages, clicks the seller info trigger, and parses the modal dialog. Handles Cloudflare challenges and cookie banners automatically.

```bash
python scripts/autodata_project/scraper.py [options]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--max-pages N` | unlimited | Stop after N listing pages |
| `--limit N` | unlimited | Stop after N sellers collected |
| `--concurrency N` | `3` | Parallel browser contexts |
| `--delay MS` | `1000` | Delay between requests (ms) |
| `--cdp-url WS` | — | Attach to existing browser via CDP |
| `--incognito` | off | Use incognito context |

**Output:** JSONL file — one JSON object per seller per line.

---

## sort_by_country.py — Group sellers by country

Reads a deduplicated seller JSON file, detects each seller's country from their phone number prefix (88 international prefixes supported), and groups them by country.

```bash
python scripts/autodata_project/sort_by_country.py
```

**Input:** deduplicated RRR seller JSON  
**Output:** `sellers_by_country.json` — sellers grouped under country keys

```json
{
  "Lithuania": [ { "name": "...", "phone": "+370 600 00000" } ],
  "Latvia":    [ { "name": "...", "phone": "+371 200 00000" } ]
}
```

---

## Scrapy settings summary

| Setting | Value |
|---|---|
| Concurrent requests | 4 (max 2 per domain) |
| Download delay | 1.5 s with autothrottle |
| Retry on HTTP errors | 500, 502, 503, 504, 408 |
| Cookies | enabled |
| robots.txt | respected |
