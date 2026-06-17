// Quick test to see what response we get from rrr.lt URLs

const testUrl = 'https://rrr.lt/autodalis/ego125044-8514134-bmw-7-g11-g12-kuro-ipurskimo-sistemos-komplektas';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function test() {
  console.log(`Testing: ${testUrl}\n`);

  try {
    const res = await fetch(testUrl, {
      headers: HEADERS,
      redirect: 'manual'
    });

    console.log(`Status: ${res.status}`);
    console.log(`Status Text: ${res.statusText}`);
    console.log(`Location Header: ${res.headers.get('location') || 'none'}`);
    console.log(`Content-Type: ${res.headers.get('content-type') || 'none'}`);

    if (res.status >= 301 && res.status <= 308) {
      const location = res.headers.get('location');
      if (location) {
        const dest = new URL(location, testUrl).href;
        console.log(`\nRedirects to: ${dest}`);

        // Check path comparison
        const origPath = new URL(testUrl).pathname.replace(/\/+$/, '');
        const destPath = new URL(dest).pathname.replace(/\/+$/, '');
        console.log(`Original path: ${origPath}`);
        console.log(`Destination path: ${destPath}`);
        console.log(`Paths match: ${origPath === destPath}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

test();
