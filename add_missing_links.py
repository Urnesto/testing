"""
Adds missing seller links to a JSON data file.

Reads a JSON file, identifies entries where seller_info is missing a 'link',
visits the URL for that entry, scrapes the seller link from a dialog,
and writes the updated data back to a new file.

Setup:
    pip install -r requirements.txt
    playwright install chromium

Run:
    python add_missing_links.py --input-file fulldata_final.json --output-file fulldata_with_links.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

from playwright.async_api import Browser, BrowserContext, Page, TimeoutError, async_playwright

# Constants from the original scraper, adapted for this script's purpose
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['pl-PL', 'pl', 'en-US', 'en']});
window.chrome = window.chrome || {runtime: {}};
"""

SELLER_BOX = "div.MuiBox-root.mui-13tch2g"
SELLER_TITLE = '[data-testid="seller-info-title"]'
DIALOG = 'div[role="dialog"]'
DIALOG_CONTENT = f"{DIALOG} div.MuiDialogContent-root.mui-p03obv"
DIALOG_ACTIONS = f"{DIALOG} div.MuiDialogActions-root.MuiDialogActions-spacing.mui-ehtod9"


def clean_text(value: str) -> str:
    """Removes extra whitespace from a string."""
    return re.sub(r"\s+", " ", value).strip()


async def accept_cookies(page: Page) -> None:
    """Accepts cookie banners if they appear."""
    labels = [
        "Zezwól na wszystkie ciasteczka",
        "Korzystaj wyłącznie z niezbędnych plików cookie",
        "Akceptuj wszystkie",
        "Accept all",
    ]
    for label in labels:
        try:
            button = page.get_by_text(label, exact=True).first
            if await button.count():
                await button.click(timeout=2500)
                await page.wait_for_timeout(500)
                return
        except TimeoutError:
            continue


async def wait_if_cloudflare(page: Page) -> None:
    """Waits if a Cloudflare verification page is detected."""
    body = ""
    try:
        body = await page.locator("body").inner_text(timeout=3000)
    except TimeoutError:
        return

    if "Przeprowadzanie weryfikacji zabezpieczeń" not in body and "Cloudflare" not in body:
        return

    print("Cloudflare/security verification detected.")
    print("If a browser window is visible, complete the verification there.")
    try:
        await page.wait_for_function(
            """() => !document.body.innerText.includes('Cloudflare')
                && !document.body.innerText.includes('Przeprowadzanie weryfikacji zabezpieczeń')""",
            timeout=180_000,
        )
    except TimeoutError:
        print("Verification did not clear within 180 seconds; skipping this page.")


async def click_seller_info(page: Page) -> bool:
    """Finds and clicks the seller info trigger to open the dialog."""
    selectors = [
        '[data-testid="seller-info-trigger"]',
        SELLER_BOX,
        SELLER_TITLE,
    ]

    for selector in selectors:
        locator = page.locator(selector)
        count = await locator.count()
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if not await candidate.is_visible(timeout=1000):
                    continue
                await candidate.scroll_into_view_if_needed(timeout=5000)
                await candidate.click(timeout=8000, force=True)
                if await dialog_opened(page):
                    return True
            except TimeoutError:
                continue
    return False


async def dialog_opened(page: Page) -> bool:
    """Checks if the seller info dialog has opened."""
    try:
        await page.wait_for_selector(DIALOG, timeout=2500)
        return True
    except TimeoutError:
        return False


async def scrape_seller_link(
    context: BrowserContext,
    product_url: str,
    use_stealth: bool,
) -> str | None:
    """Scrapes the seller link from a product page."""
    page = await context.new_page()
    if use_stealth:
        await page.add_init_script(STEALTH_JS)

    try:
        await page.goto(product_url, wait_until="domcontentloaded", timeout=90_000)
        await wait_if_cloudflare(page)
        await accept_cookies(page)

        if not await click_seller_info(page):
            print(f"No seller-info trigger found: {product_url}")
            return None

        await page.wait_for_selector(DIALOG_CONTENT, timeout=20_000)

        action_link = page.locator(f"{DIALOG_ACTIONS} a[href]").first
        if await action_link.count():
            href = await action_link.get_attribute("href")
            if href:
                return urljoin(product_url, href)

        return None

    except TimeoutError as exc:
        print(f"Timeout on product: {product_url} ({exc})")
        return None
    finally:
        await page.close()


@dataclass
class ScrapeState:
    """Holds the state of the scraping process."""
    processed_count: int = 0
    links_found: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def increment_processed(self):
        async with self.lock:
            self.processed_count += 1

    async def increment_links_found(self):
        async with self.lock:
            self.links_found += 1


async def process_item(
    item: dict[str, Any],
    context: BrowserContext,
    args: argparse.Namespace,
    state: ScrapeState,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    """Processes a single item from the input file."""
    seller_info = item.get("seller_info", {})
    if seller_info and "link" in seller_info and seller_info["link"]:
        return item  # Link already exists, no need to process

    async with semaphore:
        product_url = item["url"]
        print(f"Searching for link in: {product_url}")
        link = await scrape_seller_link(context, product_url, args.stealth)

        if link:
            print(f"  -> Found link: {link}")
            item["seller_info"]["link"] = link
            await state.increment_links_found()
        else:
            print(f"  -> No link found for: {product_url}")
        
        await state.increment_processed()
        processed = state.processed_count
        found = state.links_found
        print(f"Progress: {processed} items processed, {found} new links found.")

    return item


def browser_args(args: argparse.Namespace) -> list[str]:
    """Constructs browser launch arguments."""
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
    ]
    if args.guest:
        launch_args.append("--guest")
    if args.incognito:
        launch_args.append("--incognito")
    return launch_args


def context_options(args: argparse.Namespace) -> dict[str, Any]:
    """Constructs browser context options."""
    options: dict[str, Any] = {
        "viewport": {"width": 1920, "height": 1080},
        "locale": "pl-PL",
        "extra_http_headers": {
            "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
        },
    }
    if args.user_agent:
        options["user_agent"] = args.user_agent
    return options


async def run(args: argparse.Namespace) -> None:
    """Main function to run the scraper."""
    input_path = Path(args.input_file)
    if not input_path.exists():
        print(f"Error: Input file not found at {input_path}")
        return

    with input_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    # Deduplicate data based on "Telefonas"
    print(f"Original item count: {len(data)}")
    seen_phones = set()
    deduplicated_data = []
    for item in data:
        seller_info = item.get("seller_info", {})
        phone = seller_info.get("Telefonas")
        if phone and phone in seen_phones:
            continue
        if phone:
            seen_phones.add(phone)
        deduplicated_data.append(item)
    
    print(f"Item count after deduplication by phone: {len(deduplicated_data)}")


    items_to_process = [
        item for item in deduplicated_data 
        if not (item.get("seller_info", {}).get("link"))
    ]
    
    if not items_to_process:
        print("No items with missing links found. Exiting.")
        return

    print(f"Found {len(items_to_process)} items with missing links.")

    async with async_playwright() as playwright:
        browser: Browser | None = None
        context: BrowserContext
        
        launch_options = {
            "headless": args.headless,
            "slow_mo": args.slow_mo,
            "args": browser_args(args),
        }
        if args.channel:
            launch_options["channel"] = args.channel
        
        browser = await playwright.chromium.launch(**launch_options)
        context = await browser.new_context(**context_options(args))

        state = ScrapeState()
        semaphore = asyncio.Semaphore(args.concurrency)
        
        tasks = [
            process_item(item, context, args, state, semaphore)
            for item in items_to_process
        ]
        
        processed_items_with_links = await asyncio.gather(*tasks)

        # Create a map of url -> new_item for efficient update
        processed_map = {item['url']: item for item in processed_items_with_links}

        # Update original data list
        updated_data = []
        for original_item in deduplicated_data:
            if original_item['url'] in processed_map:
                updated_data.append(processed_map[original_item['url']])
            else:
                updated_data.append(original_item)

        output_path = Path(args.output_file)
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(updated_data, f, ensure_ascii=False, indent=4)

        print(f"\nProcessing complete.")
        print(f"Total items processed: {state.processed_count}")
        print(f"New links found: {state.links_found}")
        print(f"Updated data saved to: {output_path}")

        await context.close()
        if browser:
            await browser.close()


def parse_args() -> argparse.Namespace:
    """Parses command-line arguments."""
    parser = argparse.ArgumentParser(description="Add missing seller links to JSON data.")
    parser.add_argument(
        "--input-file",
        required=True,
        help="Path to the input JSON file (e.g., fulldata_final.json).",
    )
    parser.add_argument(
        "--output-file",
        required=True,
        help="Path to save the updated JSON file.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=5,
        help="Number of items to process concurrently.",
    )
    parser.add_argument("--slow-mo", type=int, default=50, help="Slows down Playwright operations by ms.")
    parser.add_argument(
        "--channel",
        choices=["chrome", "msedge", "chromium"],
        default="",
        help="Use installed Chrome/Edge instead of Playwright's bundled Chromium.",
    )
    parser.add_argument(
        "--guest",
        action="store_true",
        help="Launch Chrome/Edge with --guest.",
    )
    parser.add_argument(
        "--incognito",
        action="store_true",
        help="Open an incognito/private browser context.",
    )
    parser.add_argument(
        "--user-agent",
        default="",
        help="Optional custom user agent.",
    )
    parser.add_argument(
        "--stealth",
        action="store_true",
        help="Inject simple navigator patches.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run without a visible browser window.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
