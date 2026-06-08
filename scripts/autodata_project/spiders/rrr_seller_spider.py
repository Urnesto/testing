"""
RRR.lt auto-parts seller scraper — Scrapy + scrapy-playwright.

Flow
----
1. Catalog (https://rrr.lt/autodaliu-katalogas)
   - Click every <a href="#parts-N"> accordion tab
   - Collect <a> hrefs inside div.parts_all-categories

2. Each category URL (all in parallel, Scrapy-native)
   - Paginate via &page=N until no products found
   - Collect product URLs from div.products__items__wrapper

3. Each product page
   - Click [data-testid="seller-info-title"]
   - Wait for <div role="dialog">
   - Parse .MuiBox-root.mui-5s4nhv: <p><strong>=key, rest=value
   - Get <a href> from MuiDialogActions → save as "list"

sci=123,72 appended to every category / product URL.
"""

import re

import scrapy

CATALOG_URL = "https://rrr.lt/autodaliu-katalogas"
SCI_PARAM = "sci=123,72"
MAX_PAGES = 500

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def _add_sci(url: str) -> str:
    if "sci=123" not in url:
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}{SCI_PARAM}"
    return url


def _paginate_url(base: str, page_num: int) -> str:
    clean = re.sub(r"[?&]page=\d+", "", base).rstrip("?&")
    clean = _add_sci(clean)
    if page_num == 1:
        return clean
    return f"{clean}&page={page_num}"


def _pw_meta(**extra) -> dict:
    """Base playwright meta dict."""
    return {
        "playwright": True,
        "playwright_include_page": True,
        "playwright_context_kwargs": {
            "user_agent": _UA,
            "viewport": {"width": 1280, "height": 900},
        },
        **extra,
    }


async def _dismiss_cookies(page) -> None:
    for sel in [
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "#CybotCookiebotDialogBodyButtonAccept",
        "a#CybotCookiebotDialogBodyLevelButtonAccept",
        "button[id*='accept']",
    ]:
        try:
            btn = page.locator(sel).first
            if await btn.is_visible(timeout=2_000):
                await btn.click()
                await page.wait_for_timeout(500)
                return
        except Exception:
            pass


class RrrSellerSpider(scrapy.Spider):
    name = "rrr_seller"
    allowed_domains = ["rrr.lt"]

    custom_settings = {
        "DOWNLOAD_HANDLERS": {
            "http": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
            "https": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
        },
        "TWISTED_REACTOR": "twisted.internet.asyncioreactor.AsyncioSelectorReactor",
        "PLAYWRIGHT_BROWSER_TYPE": "chromium",
        "PLAYWRIGHT_LAUNCH_OPTIONS": {
            "headless": True,
            "args": ["--disable-blink-features=AutomationControlled"],
        },
        "PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT": 60_000,
        "PLAYWRIGHT_MAX_PAGES_PER_CONTEXT": 4,  # pages per browser context
        "PLAYWRIGHT_MAX_CONTEXTS": 8,            # parallel browser contexts → 32 pages total
        "CONCURRENT_REQUESTS": 32,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 32,
        "DOWNLOAD_DELAY": 0,
        "AUTOTHROTTLE_ENABLED": False,
        "ROBOTSTXT_OBEY": False,
        "FEEDS": {
            "output/rrr_seller_scrapy.json": {
                "format": "json",
                "encoding": "utf-8",
                "indent": 2,
                "overwrite": True,
            }
        },
        "LOG_LEVEL": "INFO",
    }

    # ── Start ─────────────────────────────────────────────────────────────────

    def start_requests(self):
        yield scrapy.Request(
            CATALOG_URL,
            callback=self.parse_catalog,
            meta=_pw_meta(),
            errback=self.handle_error,
        )

    # ── Stage 1: catalog → category URLs ──────────────────────────────────────

    async def parse_catalog(self, response):
        page = response.meta["playwright_page"]

        try:
            await page.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
            )
            await _dismiss_cookies(page)
            await page.wait_for_timeout(800)

            tabs = await page.query_selector_all('a[href^="#parts-"]')
            self.logger.info("Accordion tabs found: %d", len(tabs))

            seen: set[str] = set()
            cat_urls: list[str] = []

            for tab in tabs:
                anchor = await tab.get_attribute("href")
                if not anchor:
                    continue
                try:
                    await tab.scroll_into_view_if_needed()
                    await tab.click()
                    await page.wait_for_timeout(600)
                except Exception as exc:
                    self.logger.warning("Cannot click tab %s: %s", anchor, exc)
                    continue

                panel_id = anchor.lstrip("#")
                panel = await page.query_selector(f"#{panel_id}")
                if not panel:
                    self.logger.warning("Panel #%s not found", panel_id)
                    continue

                cats_div = await panel.query_selector('[class*="parts_all-categories"]')
                if not cats_div:
                    self.logger.warning("No parts_all-categories in #%s", panel_id)
                    continue

                links = await cats_div.query_selector_all("a")
                new_links = 0
                for link in links:
                    href = await link.get_attribute("href")
                    if not href or href in seen:
                        continue
                    seen.add(href)
                    if href.startswith("/"):
                        href = "https://rrr.lt" + href
                    cat_urls.append(href)
                    new_links += 1

                self.logger.info(
                    "Tab %s → %d new links (total %d)", anchor, new_links, len(cat_urls)
                )

        finally:
            await page.close()

        self.logger.info("Total categories: %d — launching all in parallel", len(cat_urls))

        for cat_url in cat_urls:
            yield scrapy.Request(
                _paginate_url(cat_url, 1),
                callback=self.parse_category_page,
                meta=_pw_meta(cat_url=cat_url, page_num=1),
                errback=self.handle_error,
            )

    # ── Stage 2: category page → product URLs ─────────────────────────────────

    async def parse_category_page(self, response):
        page = response.meta["playwright_page"]
        cat_url: str = response.meta["cat_url"]
        page_num: int = response.meta["page_num"]

        product_urls: list[str] = []

        try:
            try:
                await page.wait_for_selector(
                    "section.products.products--list", timeout=15_000
                )
            except Exception:
                self.logger.info(
                    "No products section on %s page %d — end of category", cat_url, page_num
                )
                return

            await page.wait_for_timeout(500)

            wrappers = await page.query_selector_all(
                "section.products.products--list .products__items__wrapper"
            )
            self.logger.info(
                "  %s page %d → %d wrappers", cat_url.split("/")[-1], page_num, len(wrappers)
            )

            if not wrappers:
                return

            for wrapper in wrappers:
                info_div = await wrapper.query_selector(".products__info")
                if not info_div:
                    continue
                a_tag = await wrapper.query_selector("a[href]")
                if not a_tag:
                    a_tag = await info_div.query_selector("a[href]")
                if not a_tag:
                    continue
                href = await a_tag.get_attribute("href")
                if not href:
                    continue
                if href.startswith("/"):
                    href = "https://rrr.lt" + href
                product_urls.append(_add_sci(href))

        finally:
            await page.close()

        if not product_urls:
            return

        # Next page (category pagination)
        if page_num < MAX_PAGES:
            yield scrapy.Request(
                _paginate_url(cat_url, page_num + 1),
                callback=self.parse_category_page,
                meta=_pw_meta(cat_url=cat_url, page_num=page_num + 1),
                errback=self.handle_error,
            )

        for prod_url in product_urls:
            yield scrapy.Request(
                prod_url,
                callback=self.parse_product,
                meta=_pw_meta(),
                errback=self.handle_error,
            )

    # ── Stage 3: product page → seller modal ──────────────────────────────────

    async def parse_product(self, response):
        page = response.meta["playwright_page"]
        record: dict = {"url": response.url, "seller_info": {}}

        try:
            await _dismiss_cookies(page)

            # Click seller info trigger
            trigger = page.locator('[data-testid="seller-info-title"]').first
            try:
                await trigger.wait_for(state="visible", timeout=10_000)
            except Exception:
                self.logger.warning("seller-info-title not found: %s", response.url)
                yield record
                return

            await trigger.scroll_into_view_if_needed()
            await trigger.click()

            # Wait for modal dialog
            dialog = page.locator('[role="dialog"]').first
            try:
                await dialog.wait_for(state="visible", timeout=10_000)
            except Exception:
                self.logger.warning("Dialog did not open: %s", response.url)
                yield record
                return

            await page.wait_for_timeout(500)

            # Find content box inside dialog
            box = dialog.locator(".MuiBox-root.mui-5s4nhv").first
            try:
                await box.wait_for(state="visible", timeout=4_000)
                container = box
            except Exception:
                container = dialog

            # Parse <p> elements: <strong> = key, rest = value
            info: dict[str, str] = {}
            for p in await container.locator("p").all():
                full_text = (await p.inner_text()).strip()
                if not full_text:
                    continue
                strongs = await p.locator("strong").all()
                if strongs:
                    strong_text = (await strongs[0].inner_text()).strip()
                    key = strong_text.rstrip(":").strip()
                    value = full_text.replace(strong_text, "", 1).lstrip(": ").strip()
                else:
                    key = f"note_{len(info)}"
                    value = full_text
                if key:
                    info[key] = value

            # Get listing href from dialog actions → "list" key
            for sel in [
                ".MuiDialogActions-root.MuiDialogActions-spacing",
                "[class*='MuiDialogActions-root']",
            ]:
                try:
                    actions = dialog.locator(sel).first
                    a_tag = actions.locator("a[href]").first
                    href = await a_tag.get_attribute("href", timeout=3_000)
                    if href:
                        info["list"] = href
                        break
                except Exception:
                    pass

            record["seller_info"] = info
            self.logger.info("  %d fields ← %s", len(info), response.url)

        except Exception as exc:
            self.logger.warning("Error on %s: %s", response.url, exc)
        finally:
            await page.close()

        yield record

    # ── Error handler ─────────────────────────────────────────────────────────

    async def handle_error(self, failure):
        self.logger.error("Request failed: %s — %s", failure.request.url, failure.value)
