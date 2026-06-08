#!/usr/bin/env python3
"""Launch the rrr_seller Scrapy spider from the project root."""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent / "autodata_project"
REPO_ROOT = Path(__file__).resolve().parent.parent


def main():
    os.chdir(REPO_ROOT / "scripts")

    try:
        from scrapy.cmdline import execute
    except ImportError:
        print("Scrapy not installed. Run: pip install scrapy scrapy-playwright")
        sys.exit(1)

    try:
        import scrapy_playwright  # noqa: F401
    except ImportError:
        print("scrapy-playwright not installed. Run: pip install scrapy-playwright")
        sys.exit(1)

    print("Starting rrr_seller spider (all categories in parallel)…")
    execute(["scrapy", "crawl", "rrr_seller"])


if __name__ == "__main__":
    main()
