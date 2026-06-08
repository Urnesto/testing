// Shared proxy loader — parses proxyscrape format (user:pass@host:port)
// and exports a round-robin picker used by both scrapers.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadProxies(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const proxies = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    // Normalise all formats to http://user:pass@host:port
    if (l.startsWith('http://') || l.startsWith('https://') || l.startsWith('socks5://')) {
      proxies.push(l);
    } else if (l.includes('@')) {
      // user:pass@host:port
      proxies.push(`http://${l}`);
    } else {
      const parts = l.split(':');
      if (parts.length === 4) {
        // host:port:user:pass
        proxies.push(`http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`);
      } else if (parts.length === 2) {
        // host:port (no auth)
        proxies.push(`http://${l}`);
      }
    }
  }
  return proxies;
}

// Round-robin proxy picker — thread-safe for single event loop
export function makeProxyPicker(proxies) {
  if (!proxies.length) return () => null;
  let idx = 0;
  return () => proxies[idx++ % proxies.length];
}

// Default proxies file
const DEFAULT_FILE = join(__dirname, 'proxyscrape_premium_http_proxies.txt');

export const proxies    = loadProxies(DEFAULT_FILE);
export const pickProxy  = makeProxyPicker(proxies);

export default proxies;
