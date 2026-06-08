import json
import asyncio
import argparse
import csv
from pathlib import Path
from urllib.parse import urljoin
from playwright.async_api import async_playwright

INPUT_FILE = Path(__file__).parent / "fulldata_with_links.json"
OUTPUT_JSON_FILE = Path(__file__).parent / "fulldata_with_totals.json"
OUTPUT_CSV_FILE = Path(__file__).parent / "fulldata_with_totals.csv"



def parse_count(text: str) -> str:
    return text.replace("\xa0", " ").strip()


async def fetch_total_items(page, seller_link: str) -> str | None:
    try:
        await page.goto(seller_link, wait_until="load", timeout=60000)

        filter_btn = page.locator('a[data-testid="seller-filter-button"]').first
        await filter_btn.wait_for(state="attached", timeout=20000)
        href = await filter_btn.get_attribute("href")
        if not href:
            raise ValueError("filter button has no href")

        if not href.startswith("http"):
            href = urljoin(seller_link, href)

        await page.goto(href, wait_until="load", timeout=60000)

        # Wait until the Lithuania li has a non-zero data-total
        await page.wait_for_function(
            """() => {
                const input = document.getElementById('sci-123');
                if (!input) return false;
                const li = input.closest('li.cat_options__items');
                return li && li.getAttribute('data-total') > '0';
            }""",
            timeout=20000,
        )

        total = await page.evaluate(
            """() => {
                const input = document.getElementById('sci-123');
                const li = input.closest('li.cat_options__items');
                return li.getAttribute('data-total');
            }"""
        )
        return total

    except Exception as exc:
        print(f"  [WARN] {seller_link}: {exc}")
        return None


async def main(cdp_url: str | None):
    data = json.loads(INPUT_FILE.read_text(encoding="utf-8"))

    link_cache: dict[str, str | None] = {}
    links_to_fetch: list[str] = []
    for item in data:
        link = (item.get("seller_info") or {}).get("link")
        if link and link not in link_cache:
            link_cache[link] = None
            links_to_fetch.append(link)

    print(f"Found {len(data)} items, {len(links_to_fetch)} unique seller links.")

    async with async_playwright() as pw:
        if cdp_url:
            # Connect to an already-running Chrome (bypasses Cloudflare)
            print(f"Connecting to existing browser via CDP: {cdp_url}")
            browser = await pw.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
        else:
            print("Launching new browser (headless=False)...")
            browser = await pw.chromium.launch(headless=False)
            context = await browser.new_context()
            page = await context.new_page()

        for i, link in enumerate(links_to_fetch, 1):
            print(f"[{i}/{len(links_to_fetch)}] {link}")
            total = await fetch_total_items(page, link)
            link_cache[link] = total
            print(f"  -> totalItems: {total}")

        if not cdp_url:
            await browser.close()

    for item in data:
        link = (item.get("seller_info") or {}).get("link")
        if link and link in link_cache:
            item["totalItems"] = link_cache[link]

    # Flatten the data structure
    flattened_data = []
    for item in data:
        flat_item = item.get("seller_info", {}).copy()
        flat_item["totalItems"] = item.get("totalItems")
        # Ensure totalItems is an integer for sorting
        try:
            flat_item["totalItems"] = int(flat_item["totalItems"]) if flat_item["totalItems"] else 0
        except (ValueError, TypeError):
            flat_item["totalItems"] = 0
        flattened_data.append(flat_item)

    # Sort by totalItems descending
    flattened_data.sort(key=lambda x: x.get("totalItems", 0), reverse=True)

    # Save to JSON
    OUTPUT_JSON_FILE.write_text(
        json.dumps(flattened_data, ensure_ascii=False, indent=4), encoding="utf-8"
    )
    print(f"\nDone. JSON output written to {OUTPUT_JSON_FILE}")

    # Save to CSV
    if flattened_data:
        headers = flattened_data[0].keys()
        with open(OUTPUT_CSV_FILE, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            writer.writerows(flattened_data)
        print(f"CSV output written to {OUTPUT_CSV_FILE}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cdp-url", help="Chrome DevTools Protocol URL to connect to an existing browser.")
    args = parser.parse_args()
    asyncio.run(main(args.cdp_url))



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cdp-url",
        default=None,
        help="CDP endpoint of a running Chrome, e.g. http://127.0.0.1:9222",
    )
    args = parser.parse_args()
    asyncio.run(main(args.cdp_url))
