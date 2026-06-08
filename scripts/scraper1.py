"""
Ovoko seller-info scraper.

Setup:
    pip install -r requirements.txt
    playwright install chromium

Run:
    python scrap_by_multiple_links.py

Useful options:
    python scrap_by_multiple_links.py --max-pages 3
    python scrap_by_multiple_links.py --limit 500
    python scrap_by_multiple_links.py --cdp-url http://127.0.0.1:9222 --parallel-start-urls 3
    python scrap_by_multiple_links.py --start-url "https://rrr.lt/paieska?cpc=134&sci=123&prs=1&page=20" --start-url "https://rrr.lt/paieska?cpc=624&sci=123&prs=1&page=1"

Output:
    Writes one JSON object per seller dialog to output.jsonl.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from playwright.async_api import BrowserContext, Page, TimeoutError, async_playwright

START_URLS = [
    "https://rrr.lt/paieska?cpc=281&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=1168&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=579&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=382&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=541&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=1249&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=624&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=197&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=416&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=330&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=498&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=999&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=463&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=806&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=1&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=1189&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=98&sci=123&prs=1&page=1",
    "https://rrr.lt/paieska?cpc=250&sci=123&prs=1&page=1",
]
OUTPUT_FILE = "output1.jsonl"

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


def get_page(url: str, default: int = 1) -> int:
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    try:
        return int(params.get("page", default))
    except (TypeError, ValueError):
        return default


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


@dataclass
class ScrapeState:
    output_path: Path
    output_lock: asyncio.Lock
    seen_lock: asyncio.Lock
    count_lock: asyncio.Lock
    seen_urls: set[str]
    scraped: int = 0


async def already_seen(state: ScrapeState, product_url: str) -> bool:
    async with state.seen_lock:
        if product_url in state.seen_urls:
            return True
        state.seen_urls.add(product_url)
        return False


async def limit_reached(args: argparse.Namespace, state: ScrapeState) -> bool:
    if not args.limit:
        return False
    async with state.count_lock:
        return state.scraped >= args.limit


async def save_item(state: ScrapeState, item: dict[str, Any]) -> int:
    async with state.output_lock:
        with state.output_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(item, ensure_ascii=False) + "\n")

    async with state.count_lock:
        state.scraped += 1
        return state.scraped


async def scrape_one_product(
    context: BrowserContext,
    product_url: str,
    args: argparse.Namespace,
    state: ScrapeState,
    product_semaphore: asyncio.Semaphore,
) -> None:
    if await already_seen(state, product_url):
        return
    if await limit_reached(args, state):
        return

    async with product_semaphore:
        if await limit_reached(args, state):
            return

        item = await scrape_product(context, product_url, args.stealth)
        if not item:
            return

        saved_count = await save_item(state, item)
        print(f"Saved {saved_count}: {product_url}")
        await asyncio.sleep(args.delay)


async def scrape_start_url(
    context: BrowserContext,
    start_url: str,
    args: argparse.Namespace,
    state: ScrapeState,
    product_semaphore: asyncio.Semaphore,
) -> None:
    page_number = args.start_page or get_page(start_url)
    last_page = page_number + args.max_pages if args.max_pages else None
    empty_pages_seen = 0

    while True:
        if last_page is not None and page_number >= last_page:
            return
        if await limit_reached(args, state):
            return

        listing_url = set_page(start_url, page_number)
        print(f"[start={start_url}] Listing page {page_number}: {listing_url}")
        listing_page = await open_listing_page(context, listing_url, args.stealth)

        try:
            product_urls = await listing_product_urls(listing_page, listing_url)
        except TimeoutError:
            product_urls = []
            print(f"No products section found: {listing_url}.")
        finally:
            await listing_page.close()

        if not product_urls:
            empty_pages_seen += 1
            if empty_pages_seen > args.empty_page_retries:
                print(
                    f"No products found after {empty_pages_seen} empty page(s): "
                    f"{listing_url}; stopping this start URL."
                )
                return

            print(
                f"No products found: {listing_url}; trying next page "
                f"({empty_pages_seen}/{args.empty_page_retries})."
            )
            page_number += 1
            continue

        empty_pages_seen = 0
        print(f"[page {page_number}] Found {len(product_urls)} products.")
        tasks = [
            asyncio.create_task(
                scrape_one_product(context, product_url, args, state, product_semaphore)
            )
            for product_url in product_urls
        ]
        await asyncio.gather(*tasks)
        page_number += 1


def load_start_urls(args: argparse.Namespace) -> list[str]:
    urls: list[str] = []
    if args.start_urls_file:
        file_path = Path(args.start_urls_file)
        urls.extend(
            line.strip()
            for line in file_path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        )
    if args.start_url:
        urls.extend(args.start_url)
    if not urls:
        urls.extend(START_URLS)
    return list(dict.fromkeys(urls))


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
    start_urls = load_start_urls(args)
    print(f"Loaded {len(start_urls)} start URL(s).")

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

        state = ScrapeState(
            output_path=output_path,
            output_lock=asyncio.Lock(),
            seen_lock=asyncio.Lock(),
            count_lock=asyncio.Lock(),
            seen_urls=set(),
        )
        product_semaphore = asyncio.Semaphore(args.product_concurrency)
        start_url_semaphore = asyncio.Semaphore(args.parallel_start_urls)

        try:
            async def guarded_scrape(start_url: str) -> None:
                async with start_url_semaphore:
                    await scrape_start_url(
                        context,
                        start_url,
                        args,
                        state,
                        product_semaphore,
                    )

            await asyncio.gather(
                *(asyncio.create_task(guarded_scrape(start_url)) for start_url in start_urls)
            )

        finally:
            if not args.cdp_url:
                await context.close()
            if browser and not args.cdp_url:
                await browser.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape Ovoko seller dialog data.")
    parser.add_argument(
        "--start-url",
        action="append",
        default=None,
        help="Start URL. Can be passed multiple times.",
    )
    parser.add_argument(
        "--start-urls-file",
        default="",
        help="Text file with one start URL per line.",
    )
    parser.add_argument("--output", default=OUTPUT_FILE)
    parser.add_argument(
        "--start-page",
        type=int,
        default=10,
        help="0 means use each URL's own page parameter.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="Pages per start URL. 0 means scrape until empty.",
    )
    parser.add_argument(
        "--empty-page-retries",
        type=int,
        default=2,
        help="How many consecutive empty pages to skip before stopping a start URL.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Global item limit. 0 means no limit.")
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--slow-mo", type=int, default=50)
    parser.add_argument(
        "--parallel-start-urls",
        type=int,
        default=3,
        help="How many start URLs to paginate at the same time.",
    )
    parser.add_argument(
        "--product-concurrency",
        type=int,
        default=3,
        help="How many product pages to scrape at the same time across all start URLs.",
    )
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
