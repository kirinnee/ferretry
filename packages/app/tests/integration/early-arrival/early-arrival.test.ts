import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedChromium } from '../../support/browser/index.ts';

/**
 * A PAIRING LINK'S FRAGMENT MUST BE OFF THE ADDRESS BEFORE THE MODULE GRAPH HAS LOADED (shell contract S3, early half).
 *
 * The real `public/arrival.js` runs in a real Chromium, in a document shaped like `app/index.html` (the classic script
 * in the head, then the app as a module script). The module's request is HELD by the server, which is exactly the
 * window the real app has while its ~2 MB chunk downloads: the fragment must already be gone from the tab's address and
 * from the history entry, and the value must be waiting only in memory, on a property that does not enumerate.
 * The control page leaves the script out and proves the window is real: there the code is still in the address.
 *
 * The code here is obviously fake; no daemon is involved and nothing leaves loopback.
 */

const FAKE = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';
const arrival = readFileSync(join(import.meta.dir, '../../../public/arrival.js'), 'utf8');

let release: () => void = () => {};
let moduleAsked: () => void = () => {};
let asked = new Promise<void>(resolve => {
  moduleAsked = resolve;
});
let held = new Promise<void>(resolve => {
  release = resolve;
});
const shell = (withScript: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8">${withScript ? '<script src="/arrival.js"></script>' : ''}</head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/arrival.js') return new Response(arrival, { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/main.js') {
      moduleAsked();
      await held; // the module graph is "still downloading"
      return new Response('window.__booted = true;', { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(shell(!pathname.startsWith('/control')), { headers: { 'content-type': 'text/html' } });
  },
});

beforeAll(() => {
  asked = new Promise<void>(resolve => {
    moduleAsked = resolve;
  });
});
afterAll(async () => {
  release();
  await server.stop(true);
});

const open = async (path: string) => {
  asked = new Promise<void>(resolve => {
    moduleAsked = resolve;
  });
  const browser = await sharedChromium();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}${path}${FAKE}`, { waitUntil: 'commit' });
  await asked; // the parser has passed the head: the script has run, the module is still downloading
  return { page, context };
};

describe('early arrival in a real browser', () => {
  test.each(['/pair', '/app/pair', '/app/', '/'])(
    'on %s the fragment is off the address and the history entry before the module graph has loaded',
    async path => {
      const { page, context } = await open(path);
      try {
        expect(await page.evaluate(() => location.href)).toBe(`http://127.0.0.1:${server.port}${path}`);
        const memory = await page.evaluate(() => ({
          booted: (window as unknown as { __booted?: boolean }).__booted === true,
          listed: Object.keys(window).includes('__fyArrival'),
          held: JSON.stringify((window as unknown as Record<string, unknown>).__fyArrival),
          entries: history.length,
          stateHash: String(history.state),
        }));
        expect(memory.booted).toBe(false);
        expect(memory.listed).toBe(false); // does not enumerate
        expect(memory.held).toBe(JSON.stringify({ pathname: path, hash: FAKE }));
        expect(memory.entries).toBe(2); // about:blank + this page: replaceState, never pushState, so Back cannot restore the code
        expect(memory.stateHash).not.toContain('FAKE');
      } finally {
        await context.close();
      }
    },
  );

  test('control: without the early script the code sits in the address while the module downloads', async () => {
    const { page, context } = await open('/control');
    try {
      expect(await page.evaluate(() => location.hash)).toBe(FAKE);
    } finally {
      await context.close();
    }
  });
});
