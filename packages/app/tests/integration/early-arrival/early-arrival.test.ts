import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedChromium } from '../../support/browser/index.ts';

/**
 * A PAIRING LINK'S FRAGMENT MUST BE OFF THE ADDRESS BEFORE ANYTHING ELSE CAN OBSERVE IT (shell contract S3, early half).
 *
 * The REAL documents (the app's `app/index.html`, the get-started page, the OAuth callback page) and the real
 * `arrival.js` and `pre-paint.js` are served to a real Chromium under the real main CSP from `public/_headers`. Only
 * the app's module URL is pointed at a stand-in, and held by the server: exactly the window the real app has while its
 * ~2 MB chunk downloads. The theme script is held too, because it is the other parser-blocking script of the head and
 * the strip must not wait for it. The code here is obviously fake; no daemon is involved and nothing leaves loopback.
 *
 * What this cannot show: a browser or a tool that reads the address at the moment the navigation COMMITS, or echoes the
 * URL its caller typed, sees the link before any page script exists. That boundary is the tool's, not the page's
 * (`public/arrival.js` says so).
 */

const FAKE = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';
const here = (path: string): string => readFileSync(join(import.meta.dir, '../../../', path), 'utf8');
const arrival = here('public/arrival.js');
const prePaint = here('public/pre-paint.js');
const callbackScript = here('public/oauth/mcp-callback.js');
const callbackPage = here('public/oauth/mcp-callback.html');
const getStarted = here('../plugins/onboarding/app/get-started/index.html').replaceAll('%FY_RELEASE_VERSION%', '0.0.0');
const appPage = here('app/index.html').replace('/src/main.tsx', '/main.js');
const csp = /^\s*Content-Security-Policy: (.*)$/mu.exec(here('public/_headers'))?.[1] ?? '';

/** A request the server holds until the test lets it go. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  let asked: () => void = () => {};
  const wasAsked = new Promise<void>(resolve => {
    asked = resolve;
  });
  return { open, opened, asked, wasAsked };
}
let theme = gate();
let module = gate();

const js = (text: string) => new Response(text, { headers: { 'content-type': 'text/javascript' } });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/arrival.js') return js(arrival);
    if (pathname === '/oauth/mcp-callback.js') return js(callbackScript);
    if (pathname === '/pre-paint.js') {
      theme.asked();
      if (searchParams.has('hold') || request.headers.get('referer')?.includes('hold-theme')) await theme.opened;
      return js(prePaint);
    }
    if (pathname === '/main.js') {
      module.asked();
      await module.opened; // the module graph is "still downloading"
      return js('window.__booted = true;');
    }
    // The control: the same document with the strip AFTER the theme script, as the first version of this fix had it.
    if (pathname.startsWith('/control'))
      return new Response(
        appPage
          .replace('<script src="/arrival.js"></script>', '')
          .replace(
            '<script src="/pre-paint.js"></script>',
            '<script src="/pre-paint.js"></script><script src="/arrival.js"></script>',
          ),
        { headers: { 'content-type': 'text/html', 'content-security-policy': csp } },
      );
    const html = pathname.startsWith('/get-started')
      ? getStarted
      : pathname.startsWith('/oauth/mcp-callback')
        ? callbackPage
        : appPage; // /pair, /app/..., anything else the app's `_redirects` rewrite sends to the app document
    return new Response(html, {
      headers: { 'content-type': 'text/html', 'content-security-policy': csp },
    });
  },
});
afterAll(async () => {
  theme.open();
  module.open();
  await server.stop(true);
});

const open = async (path: string, wait: 'theme' | 'module' | 'load') => {
  theme = gate();
  module = gate();
  const browser = await sharedChromium();
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.port}${path}${FAKE}`;
  if (wait === 'load') {
    module.open();
    theme.open();
    await page.goto(url, { waitUntil: 'load' });
  } else {
    await page.goto(url, { waitUntil: 'commit' });
    await (wait === 'theme' ? theme.wasAsked : module.wasAsked);
  }
  return { page, context, base: `http://127.0.0.1:${server.port}` };
};

describe('early arrival in a real browser, under the real CSP', () => {
  test.each(['/pair', '/app/pair', '/app/', '/'])(
    'on %s the fragment is gone while the THEME script is still downloading (the strip is the first script)',
    async path => {
      const { page, context, base } = await open(`${path}?hold-theme=1`, 'theme');
      try {
        // The parser has reached `pre-paint.js` and waits for it: everything before it has already run.
        expect(await page.evaluate(() => location.href)).toBe(`${base}${path}?hold-theme=1`);
        expect(await page.evaluate(() => (window as unknown as { __booted?: boolean }).__booted === true)).toBe(false);
      } finally {
        theme.open();
        await context.close();
      }
    },
  );

  test.each(['/pair', '/app/pair', '/app/', '/'])(
    'on %s the fragment is off the address and the history entry before the module graph has loaded, and it is held ONCE',
    async path => {
      const { page, context, base } = await open(path, 'module');
      try {
        expect(await page.evaluate(() => location.href)).toBe(`${base}${path}`);
        const memory = await page.evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          const take = w.__fyArrival as (() => unknown) | undefined;
          return {
            booted: w.__booted === true,
            listed: Object.keys(window).includes('__fyArrival'),
            dump: JSON.stringify(Object.getOwnPropertyNames(window).map(name => String(w[name]).slice(0, 200))),
            entries: history.length,
            state: String(history.state),
            first: typeof take === 'function' ? take() : 'no hand-off',
            second: typeof take === 'function' ? take() : 'no hand-off',
            after: '__fyArrival' in window,
          };
        });
        expect(memory.booted).toBe(false);
        expect(memory.listed).toBe(false);
        expect(memory.dump).not.toContain('FAKEFAKE'); // no property of the page's window holds the value
        expect(memory.entries).toBe(2); // about:blank + this page: replaceState, never pushState
        expect(memory.state).not.toContain('FAKE');
        const declared = path === '/pair' || path === '/app/pair';
        if (declared) expect(JSON.stringify(memory.first)).toContain('FAKEFAKE');
        else expect(memory.first).toBeUndefined(); // a code on a screen that did not declare it is dropped, not kept
        // Whoever reads second, or reads again, finds nothing: take-once, and the hand-off removes itself.
        expect(memory.second).toBeUndefined();
        expect(memory.after).toBe(false);
      } finally {
        module.open();
        await context.close();
      }
    },
  );

  test.each(['/get-started/', '/oauth/mcp-callback'])(
    'on %s, a document with no taker, a pairing fragment is stripped and nothing is held',
    async path => {
      const { page, context, base } = await open(path, 'load');
      try {
        expect(await page.evaluate(() => location.href)).toBe(`${base}${path}`);
        expect(await page.evaluate(() => '__fyArrival' in window)).toBe(false);
      } finally {
        await context.close();
      }
    },
  );

  test('control: with the strip AFTER the theme script, the code sits in the address while that script downloads', async () => {
    const { page, context } = await open('/control?hold-theme=1', 'theme');
    try {
      expect(await page.evaluate(() => location.hash)).toBe(FAKE);
    } finally {
      theme.open();
      await context.close();
    }
  });

  test('a fragment navigation to the open /app/ document is stripped at once (hashchange), nothing is held', async () => {
    const { page, context, base } = await open('/app/', 'load');
    try {
      await page.evaluate(code => {
        location.hash = code;
      }, FAKE);
      await page.waitForFunction(() => location.hash === '');
      expect(await page.evaluate(() => location.href)).toBe(`${base}/app/`);
    } finally {
      await context.close();
    }
  });

  test('so is one that arrives by history traversal into an entry that holds it', async () => {
    const { page, context, base } = await open('/app/', 'load');
    try {
      // A same-document entry that carries a code (as an in-page `pushState` would make one), then away, then Back.
      await page.evaluate(code => {
        history.pushState(null, '', `/app/${code}`);
        history.pushState(null, '', '/app/other');
      }, FAKE);
      await page.evaluate(() => {
        history.back();
      });
      await page.waitForFunction(() => location.pathname === '/app/');
      await page.waitForFunction(() => location.hash === '');
      expect(await page.evaluate(() => location.href)).toBe(`${base}/app/`);
    } finally {
      await context.close();
    }
  });

  test('a second pairing link on /pair while the module is still loading replaces the first, off the address', async () => {
    const { page, context } = await open('/pair', 'module');
    try {
      await page.evaluate(() => {
        location.hash = '#v1;a=127.0.0.1:9;c=SECONDFAKE;fp=00';
      });
      await page.waitForFunction(() => location.hash === '');
      const held = await page.evaluate(() => {
        const take = (window as unknown as Record<string, unknown>).__fyArrival as () => { hash: string };
        return take().hash;
      });
      expect(held).toContain('SECONDFAKE');
    } finally {
      module.open();
      await context.close();
    }
  });
});
