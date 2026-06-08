import json
import logging
import re
from pathlib import Path

import scrapy

logger = logging.getLogger(__name__)

_WS = re.compile(r'\s+')
# Matches trailing imperial conversions like "2.95 in.", "3119.54 lbs.", "16.14 cu. ft.",
# "14.53 US gal | 12.1 UK gal", etc.
_IMPERIAL = re.compile(
    r'\s+\d[\d.,]*\s*(?:cu\.?\s*(?:in|ft)\.?|in\.|lbs?\.|(?:US|UK)\s*gal\b).*$',
    re.IGNORECASE,
)


def _clean(text):
    """Return metric-only first line of text, stripping imperial conversions."""
    first_line = text.split('\n')[0]
    first_line = _IMPERIAL.sub('', first_line)
    return _WS.sub(' ', first_line).strip()


class AutodataSpider(scrapy.Spider):
    name = "autodata"
    allowed_domains = ["www.auto-data.net"]
    start_urls = ["https://www.auto-data.net/en/allbrands"]
    custom_settings = {
        "CONCURRENT_REQUESTS": 1,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "DOWNLOAD_DELAY": 0.2,
        "RANDOMIZE_DOWNLOAD_DELAY": False,
        "FEEDS": {},
    }

    SAVE_EVERY = 100  # write to disk every N cars scraped

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.brand_data = {}
        self.skipped = []
        self._cars_scraped = 0
        self._root = Path(__file__).resolve().parents[2]

    # ------------------------------------------------------------------ #
    # Level 1 — brand listing page                                         #
    # ------------------------------------------------------------------ #

    def parse(self, response):
        # Scope to div.brands to avoid picking up stray marki_blok anchors elsewhere
        brands = response.css('div.brands a.marki_blok')
        if not brands:
            logger.warning("No brands found on %s", response.url)
            self._skip(response.url, "no_brands", context={})
            return

        for anchor in brands:
            href = anchor.attrib.get("href", "")
            brand_name = self._extract_brand_name(anchor)
            if not href:
                continue
            yield response.follow(
                href,
                callback=self.parse_brand,
                cb_kwargs={"brand": brand_name},
            )

    # ------------------------------------------------------------------ #
    # Level 2 — brand page → model list                                    #
    # ------------------------------------------------------------------ #

    def parse_brand(self, response, brand):
        model_links = response.css('a.modeli')
        if not model_links:
            logger.warning("No models found for brand '%s' on %s", brand, response.url)
            self._skip(response.url, "no_models", context={"brand": brand})
            return

        for anchor in model_links:
            href = anchor.attrib.get("href", "")
            model_name = self._extract_model_name(anchor)
            if not href:
                continue
            yield response.follow(
                href,
                callback=self.parse_model,
                cb_kwargs={"brand": brand, "model": model_name},
            )

    # ------------------------------------------------------------------ #
    # Level 3 — model page → generation list                               #
    # ------------------------------------------------------------------ #

    def parse_model(self, response, brand, model):
        gen_rows = response.css('table#generr tr, table.generr tr')
        if gen_rows:
            for row in gen_rows:
                link = row.css('th.i a.position::attr(href), a::attr(href)').get()
                if not link:
                    continue
                yield response.follow(
                    link,
                    callback=self.parse_generation,
                    cb_kwargs={"brand": brand, "model": model},
                )
            return

        mod_rows = response.css('table.carlist tr')
        if mod_rows:
            for row in mod_rows:
                link = row.css('a::attr(href)').get()
                if not link:
                    continue
                yield response.follow(
                    link,
                    callback=self.parse_car,
                    cb_kwargs={"brand": brand, "model": model},
                )
            return

        logger.warning(
            "No generations found for '%s %s' on %s", brand, model, response.url
        )
        self._skip(response.url, "no_generations", context={"brand": brand, "model": model})

    # ------------------------------------------------------------------ #
    # Level 4 — generation page → modification/variant list                #
    # ------------------------------------------------------------------ #

    def parse_generation(self, response, brand, model):
        mod_rows = response.css('table.carlist tr')
        if not mod_rows:
            logger.warning(
                "No modifications found for '%s %s' on %s", brand, model, response.url
            )
            self._skip(response.url, "no_modifications", context={"brand": brand, "model": model})
            return

        for row in mod_rows:
            link = row.css('a::attr(href)').get()
            if not link:
                continue
            yield response.follow(
                link,
                callback=self.parse_car,
                cb_kwargs={"brand": brand, "model": model},
            )

    # ------------------------------------------------------------------ #
    # Level 5 — car detail page                                            #
    # ------------------------------------------------------------------ #

    def parse_car(self, response, brand, model):
        specs = self._extract_specs_table(response)
        if not specs:
            logger.warning("No spec table found on %s — skipping item", response.url)
            self._skip(response.url, "no_spec_table", context={"brand": brand, "model": model})
            return

        brand_from_specs = specs.pop("Brand", "")
        model_from_specs = specs.pop("Model", "")

        brand_key = brand or brand_from_specs or "Unknown"
        model_name = model or model_from_specs or self._extract_model_from_heading(response)

        car = {"brand": brand_key, "model": model_name}

        image_src = response.css("img.inspecs::attr(src)").get()
        if image_src:
            car["image"] = response.urljoin(image_src)

        car.update(specs)

        self.brand_data.setdefault(brand_key, []).append(car)
        self._cars_scraped += 1
        if self._cars_scraped % self.SAVE_EVERY == 0:
            self._save()
            logger.info("Auto-saved after %d cars", self._cars_scraped)

    # ------------------------------------------------------------------ #
    # Helpers                                                              #
    # ------------------------------------------------------------------ #

    def _save(self):
        with (self._root / "cars.json").open("w", encoding="utf-8") as fh:
            json.dump(self.brand_data, fh, ensure_ascii=False, indent=2)
        with (self._root / "skipped.json").open("w", encoding="utf-8") as fh:
            json.dump(self.skipped, fh, ensure_ascii=False, indent=2)

    def _skip(self, url, reason, context):
        self.skipped.append({"url": url, "reason": reason, **context})

    def _extract_specs_table(self, response):
        """
        Parse the spec table (class 'cardetailsout car2') into a flat dict.
        Skips tables with class 'keyspecs' or 'top'.
        """
        table = response.css("table.cardetailsout.car2:not(.keyspecs):not(.top)")
        if not table:
            table = response.css("table.cardetailsout:not(.keyspecs):not(.top)")
        if not table:
            return {}

        specs = {}
        for row in table.css("tr"):
            key_node = row.css("th")
            val_node = row.css("td")
            if not key_node or not val_node:
                continue

            key = _clean(" ".join(key_node.css("::text").getall()))
            val = _clean(" ".join(val_node.css("::text").getall()))

            if key:
                specs[key] = val

        return specs

    def _extract_model_name(self, anchor):
        """
        Extract model name from a model link anchor (a.modeli).
        Uses only the first direct text node to avoid year ranges in child spans.
        """
        # First direct text child only — avoids pulling in year spans
        direct_texts = [t for t in anchor.xpath('text()').getall() if t.strip()]
        if direct_texts:
            return _clean(direct_texts[0])

        # Fallback: strong child text
        text = _clean(" ".join(anchor.css("strong::text").getall()))
        if text:
            return text

        title = anchor.attrib.get("title", "").strip()
        if title:
            return _clean(title.split("-")[0])

        img_alt = anchor.css("img::attr(alt)").get(default="").strip()
        if img_alt:
            return _clean(img_alt.split("-")[0])

        return ""

    def _extract_model_from_heading(self, response):
        h1 = _clean(" ".join(response.css("h1::text").getall()))
        if not h1:
            return ""
        parts = h1.split()
        return " ".join(parts[1:]) if len(parts) > 1 else h1

    def _extract_brand_name(self, anchor):
        text = _clean(" ".join(anchor.css("strong::text").getall()))
        if text:
            return text

        text = _clean(" ".join(anchor.css("::text").getall()))
        if text:
            return text

        title = anchor.attrib.get("title", "").strip()
        if title:
            return _clean(title.split("-")[0])

        img_alt = anchor.css("img::attr(alt)").get(default="").strip()
        if img_alt:
            return _clean(img_alt.split("-")[0])

        return ""

    def closed(self, reason):
        self._save()
        logger.info(
            "Final save: %d cars across %d brands, %d skipped pages",
            self._cars_scraped, len(self.brand_data), len(self.skipped),
        )
