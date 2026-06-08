"""
Ovoko seller-info scraper.

Setup:
    pip install -r requirements.txt
    playwright install chromium

Run:
    python scraper.py

Useful options:
    python scraper.py --max-pages 3
    python scraper.py --limit 500
    python scraper.py --headless
    python scraper.py --channel chrome --guest --max-pages 1 --limit 10
    python scraper.py --channel chrome --incognito --max-pages 1 --limit 10
    python scraper.py --channel chrome --user-data-dir .ovoko-profile --max-pages 20
    python scraper.py --cdp-url http://127.0.0.1:9222 --incognito --max-pages 20

Output:
    Writes one JSON object per seller dialog to output.jsonl.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from playwright.async_api import BrowserContext, Page, TimeoutError, async_playwright

START_URL = "https://rrr.lt/paieska?cpc=134&sci=123&prs=1&page=20"
OUTPUT_FILE = "output.json"

STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['pl-PL', 'pl', 'en-US', 'en']});
window.chrome = window.chrome || {runtime: {}};
"""

PRODUCT_SECTION = "section.products.products--list"
PRODUCT_WRAPPER = f"{PRODUCT_SECTION} div.products__items__wrapper"
SELLER_BOX = "div.MuiBox-root.mui-13tch2g"
SELLER_TITLE = '[data-testid="seller-info-title"]'
DIALOG = 'div[role="dialog"]'
DIALOG_CONTENT = f"{DIALOG} div.MuiDialogContent-root.mui-p03obv"
DIALOG_ACTIONS = (
    f"{DIALOG} div.MuiDialogActions-root.MuiDialogActions-spacing.mui-ehtod9"
)


def set_page(url: str, page_number: int) -> str:
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params["page"] = str(page_number)
    return urlunparse(parsed._replace(query=urlencode(params)))


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


async def accept_cookies(page: Page) -> None:
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


async def listing_product_urls(page: Page, base_url: str) -> list[str]:
    await page.wait_for_selector(PRODUCT_SECTION, timeout=45_000)
    await page.wait_for_timeout(1000)

    wrappers = page.locator(PRODUCT_WRAPPER)
    count = await wrappers.count()
    urls: list[str] = []

    for index in range(count):
        wrapper = wrappers.nth(index)
        href = await best_product_href(wrapper)
        if href:
            urls.append(urljoin(base_url, href))

    return list(dict.fromkeys(urls))


async def best_product_href(wrapper: Any) -> str | None:
    selectors = [
        'a[data-trackable-link="product_card"][href]',
        "a.products__items__link[href]",
        'a[href*="/czesci-samochodowe/"]',
    ]
    for selector in selectors:
        locator = wrapper.locator(selector).first
        if await locator.count():
            href = await locator.get_attribute("href")
            if href:
                return href

    links = await wrapper.locator("a[href]").evaluate_all(
        """anchors => anchors
            .map(a => a.getAttribute('href'))
            .filter(Boolean)
            .filter(href => !href.includes('/cart/add/') && !href.includes('/oferta/'))"""
    )
    return links[0] if links else None


async def open_listing_page(context: BrowserContext, url: str, use_stealth: bool) -> Page:
    page = await context.new_page()
    if use_stealth:
        await page.add_init_script(STEALTH_JS)
    await page.goto(url, wait_until="domcontentloaded", timeout=90_000)
    await wait_if_cloudflare(page)
    await accept_cookies(page)
    return page


async def scrape_product(
    context: BrowserContext,
    product_url: str,
    use_stealth: bool,
) -> dict[str, Any] | None:
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

        seller_info: dict[str, str] = {}

        rows = page.locator(f"{DIALOG_CONTENT} p")
        note_index = 0
        for index in range(await rows.count()):
            row = rows.nth(index)
            strong = row.locator("strong").first
            if not await strong.count():
                note = clean_text(await row.inner_text())
                if note:
                    seller_info[f"note_{note_index}"] = note
                    note_index += 1
                continue

            key_text = clean_text(await strong.inner_text())
            key = key_text.rstrip(":")
            full_text = clean_text(await row.inner_text())
            value = clean_text(full_text.replace(key_text, "", 1).lstrip(":"))
            if key:
                seller_info[key] = value

        action_link = page.locator(f"{DIALOG_ACTIONS} a[href]").first
        if await action_link.count():
            href = await action_link.get_attribute("href")
            if href:
                seller_info["link"] = urljoin(product_url, href)

        return {"url": product_url, "seller_info": seller_info}

    except TimeoutError as exc:
        print(f"Timeout on product: {product_url} ({exc})")
        return None
    finally:
        await page.close()


async def click_seller_info(page: Page) -> bool:
    if await click_visible_seller_trigger_by_coordinates(page):
        return True

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

    for selector in selectors:
        locator = page.locator(selector)
        count = await locator.count()
        for index in range(count):
            candidate = locator.nth(index)
            try:
                clicked = await candidate.evaluate(
                    """element => {
                        const target = element.closest('[data-testid="seller-info-trigger"]') || element;
                        target.scrollIntoView({block: 'center', inline: 'center'});
                        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                            target.dispatchEvent(new MouseEvent(type, {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            }));
                        }
                        return true;
                    }"""
                )
                if clicked and await dialog_opened(page):
                    return True
            except Exception:
                continue

    return False


async def click_visible_seller_trigger_by_coordinates(page: Page) -> bool:
    for _ in range(3):
        boxes = await page.locator('[data-testid="seller-info-trigger"]').evaluate_all(
            """elements => elements
                .map((element, index) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return {
                        index,
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height,
                        visible: rect.width > 0
                            && rect.height > 0
                            && style.visibility !== 'hidden'
                            && style.display !== 'none'
                            && rect.bottom > 0
                            && rect.right > 0
                            && rect.top < window.innerHeight
                            && rect.left < window.innerWidth
                    };
                })
                .filter(box => box.visible)"""
        )

        if not boxes:
            await page.locator('[data-testid="seller-info-trigger"]').last.scroll_into_view_if_needed(
                timeout=5000
            )
            await page.wait_for_timeout(500)
            continue

        box = boxes[-1]
        x = box["x"] + min(box["width"] / 2, box["width"] - 8)
        y = box["y"] + min(box["height"] / 2, box["height"] - 8)
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.wait_for_timeout(80)
        await page.mouse.up()
        if await dialog_opened(page):
            return True

    return False


async def dialog_opened(page: Page) -> bool:
    try:
        await page.wait_for_selector(DIALOG, timeout=2500)
        return True
    except TimeoutError:
        return False


def browser_args(args: argparse.Namespace) -> list[str]:
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
    output_path = Path(args.output)
    output_path.write_text("", encoding="utf-8")

    async with async_playwright() as playwright:
        browser = None
        if args.cdp_url:
            browser = await playwright.chromium.connect_over_cdp(args.cdp_url)
            if args.incognito:
                context = await browser.new_context(**context_options(args))
            else:
                context = browser.contexts[0] if browser.contexts else await browser.new_context(
                    **context_options(args)
                )
        elif args.user_data_dir:
            launch_options: dict[str, Any] = {
                "headless": args.headless,
                "slow_mo": args.slow_mo,
                "args": browser_args(args),
            }
            if args.channel:
                launch_options["channel"] = args.channel
            context = await playwright.chromium.launch_persistent_context(
                user_data_dir=args.user_data_dir,
                **launch_options,
                **context_options(args),
            )
        else:
            launch_options = {
                "headless": args.headless,
                "slow_mo": args.slow_mo,
                "args": browser_args(args),
            }
            if args.channel:
                launch_options["channel"] = args.channel
            browser = await playwright.chromium.launch(**launch_options)
            context = await browser.new_context(**context_options(args))

        scraped = 0
        page_number = args.start_page

        try:
            while True:
                if args.max_pages and page_number >= args.start_page + args.max_pages:
                    break

                listing_url = set_page(args.start_url, page_number)
                print(f"Listing page {page_number}: {listing_url}")
                listing_page = await open_listing_page(context, listing_url, args.stealth)

                try:
                    product_urls = await listing_product_urls(listing_page, listing_url)
                except TimeoutError:
                    print(f"No products section found on page {page_number}; stopping.")
                    break
                finally:
                    await listing_page.close()

                if not product_urls:
                    print(f"No products found on page {page_number}; stopping.")
                    break

                print(f"Found {len(product_urls)} products.")
                for product_url in product_urls:
                    if args.limit and scraped >= args.limit:
                        return

                    item = await scrape_product(context, product_url, args.stealth)
                    if not item:
                        continue

                    with output_path.open("a", encoding="utf-8") as file:
                        file.write(json.dumps(item, ensure_ascii=False) + "\n")

                    scraped += 1
                    print(f"Saved {scraped}: {product_url}")
                    await asyncio.sleep(args.delay)

                page_number += 1

        finally:
            if not args.cdp_url:
                await context.close()
            if browser and not args.cdp_url:
                await browser.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape Ovoko seller dialog data.")
    parser.add_argument("--start-url", default=START_URL)
    parser.add_argument("--output", default=OUTPUT_FILE)
    parser.add_argument("--start-page", type=int, default=204)
    parser.add_argument("--max-pages", type=int, default=0, help="0 means scrape until empty.")
    parser.add_argument("--limit", type=int, default=0, help="0 means no product limit.")
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--slow-mo", type=int, default=50)
    parser.add_argument(
        "--channel",
        choices=["chrome", "msedge", "chromium"],
        default="",
        help="Use installed Chrome/Edge instead of Playwright's bundled Chromium.",
    )
    parser.add_argument(
        "--guest",
        action="store_true",
        help="Launch Chrome/Edge with --guest. Often useful when bundled Chromium is blocked.",
    )
    parser.add_argument(
        "--incognito",
        action="store_true",
        help="Open an incognito/private browser context. This does not reuse normal cookies.",
    )
    parser.add_argument(
        "--user-data-dir",
        default="",
        help="Persistent browser profile folder. Reuses cookies/session between runs.",
    )
    parser.add_argument(
        "--cdp-url",
        default="",
        help="Connect to Chrome/Edge started with --remote-debugging-port=9222.",
    )
    parser.add_argument(
        "--user-agent",
        default="",
        help="Optional custom user agent. By default the real browser user agent is used.",
    )
    parser.add_argument(
        "--stealth",
        action="store_true",
        help="Inject simple navigator patches. Leave off for real Chrome/CDP mode.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run without a visible browser. Visible mode is safer for Ovoko/Cloudflare.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
