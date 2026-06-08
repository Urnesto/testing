# Seller Data Scraper Project

This project contains a collection of Python scripts designed to scrape seller information from the RRR.lt website, process the data, and enrich it with additional details like total item counts.

## Scripts Overview

- `scrap_by_multiple_links.py`: The main scraper that gathers initial seller data from product pages.
- `add_missing_links.py`: A script to find and add missing seller page links to an existing data file.
- `collect_total_items.py`: A script that visits each seller's page to collect the total number of items they have for sale.
- `dedupe.py`, `sort_by_city.py`, etc.: Utility scripts for cleaning and organizing the data.

## Setup

1.  **Install Python**: Ensure you have Python 3.8 or newer installed.
2.  **Install Dependencies**: Open your terminal in the project directory and install the required Python packages.
    ```sh
    pip install -r requirements.txt
    ```
3.  **Install Playwright Browsers**: Playwright needs to download browser binaries. Run this command:
    ```sh
    playwright install
    ```

## Standard Workflow

The scripts are designed to be run in a sequence to collect, clean, and enrich the data.

1.  **Run the main scraper**:
    ```sh
    python scrap_by_multiple_links.py
    ```
2.  **Deduplicate and format the data** (using the various utility scripts).
3.  **Add missing seller links**:
    ```sh
    python add_missing_links.py --input-file fulldata_final.json --output-file fulldata_with_links.json
    ```
4.  **Collect total item counts for each seller**:
    ```sh
    python collect_total_items.py
    ```

---

## Troubleshooting Cloudflare

If the website blocks the scraper (which is common), you will need to run the scripts in a way that appears more like a real user. There are two primary methods to achieve this.

### Method 1: Persistent Browser Profile (Recommended)

This is the simplest method. The script will launch a visible browser and save its session data (cookies, etc.) to a local folder. This helps the browser "remember" its session and bypass bot detection on subsequent runs.

Run the `collect_total_items.py` script with the `--user-data-dir` argument:

```powershell
python collect_total_items.py --user-data-dir "%TEMP%\playwright-user-data"
```

This will launch a browser window. You may need to solve a CAPTCHA or wait for the Cloudflare check to complete on the first run. The script will proceed automatically once the page loads.

### Method 2: Connecting to a Manually Opened Browser

This method gives you more control. You will manually start a browser with remote debugging enabled, and then tell the script to connect to it. This requires two terminals.

**Step 1: Launch the Browser (Choose one)**

Open a **new** terminal (PowerShell or Command Prompt) and run **one** of the following commands to start either Chrome or Edge.

**For Google Chrome:**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-debug"
```

**For Microsoft Edge:**
```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\edge-debug"
```

A new browser window will open. **Keep this window and the terminal you used to launch it open.**

**Step 2: Run the Python Script**

In your **original** VS Code terminal, run the script with the `--cdp-url` argument:

```powershell
python collect_total_items.py --cdp-url "http://127.0.0.1:9222"
```

The script will now connect to the browser you opened manually and perform its tasks. When the script is finished, you can close the browser window and the extra terminal.
