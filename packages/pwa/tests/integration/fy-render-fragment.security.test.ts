/**
 * An `html` block as a STATIC FRAGMENT, in real Chromium, under the app's REAL policy.
 *
 * WHY HERE. The unit tier runs the sanitizer in happy-dom, which can prove structure but not what a
 * browser would run, and which mis-parses several elements DOMPurify must remove. This file mounts
 * the shipped `FyRenderBlock` (through the same scene the visual evidence uses) on a page served with
 * the exact `Content-Security-Policy` `public/_headers` gives the app — Trusted Types included — so
 * three things are measured rather than assumed:
 *
 *   - NOTHING RUNS: no payload in the corpus sets `window.__fyPwned`, before or after a reader clicks
 *     the links and the submit button.
 *   - NOTHING LOADS: the server's ledger sees no `/beacon?…` request — not from an image, a style,
 *     an import, an object, a frame, a refresh, a form, a link or a click.
 *   - NOTHING ESCAPES: the fragment's own `body`/`#outside` rules leave the host page's styles alone,
 *     and a `position: fixed` overlay stays inside the fragment's box.
 *
 * And it renders: the fragment's text is in its (closed) shadow root, reached here through an init
 * script that records every root as it is attached, and the page raised no Trusted Types violation.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import should from 'should';
import { sharedChromium } from './support/chromium.ts';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const ledger: string[] = [];
let policy = '';

beforeAll(async () => {
  browser = await sharedChromium();
  const fixture = await fyRenderIntegrationFixture();
  const headers = await readFile(resolve(import.meta.dir, '../../public/_headers'), 'utf8');
  policy =
    headers
      .split('\n')
      .find(line => line.trim().startsWith('Content-Security-Policy:'))
      ?.trim()
      .slice('Content-Security-Policy:'.length)
      .trim() ?? '';
  const appCss = fixture.appCss;
  const appJs = fixture.appJs;
  server = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      ledger.push(url.pathname + url.search);
      const secured = (body: string, type: string): Response =>
        new Response(body, { headers: { 'content-security-policy': policy, 'content-type': type } });
      if (url.pathname === '/app.js') return secured(appJs, 'text/javascript; charset=utf-8');
      if (url.pathname === '/app.css') return secured(appCss, 'text/css; charset=utf-8');
      if (url.pathname.startsWith('/beacon')) return secured('beacon', 'text/plain');
      return secured(
        `<!doctype html><html lang="en" data-theme="studio-dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/app.css"></head>
<body><p id="outside">outside the fragment</p><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
        'text/html; charset=utf-8',
      );
    },
    hostname: '127.0.0.1',
    port: 0,
  });
});

afterAll(async () => {
  await server?.stop(true);
});

describe('fy-render html fragment — under the app policy, in real Chromium', () => {
  test('should render the fragment while nothing in the corpus runs, loads or escapes', async () => {
    ledger.length = 0;
    const context = await browser.newContext({ viewport: { height: 900, width: 1_280 } });
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', message => {
      if (/TrustedHTML|Trusted Type|Refused|Content Security Policy/u.test(message.text()))
        violations.push(message.text());
    });
    page.on('pageerror', error => violations.push(`pageerror: ${error.message}`));
    // Every shadow root, open or closed, recorded as it is attached — the only way a test reaches a
    // closed root, and nothing the app itself can use.
    await page.addInitScript(() => {
      const attach = Element.prototype.attachShadow;
      const roots: ShadowRoot[] = [];
      (window as unknown as { __fyRoots: ShadowRoot[] }).__fyRoots = roots;
      Element.prototype.attachShadow = function (init: ShadowRootInit) {
        const root = attach.call(this, init);
        roots.push(root);
        return root;
      };
    });
    try {
      const before = await (async () => {
        await page.goto(`${server.url.origin}/?case=fragment-table`);
        await page.waitForSelector('[data-fy-render-fragment="true"]');
        return await page.evaluate(() => ({
          body: getComputedStyle(document.body).backgroundColor,
          outside: getComputedStyle(document.getElementById('outside') as HTMLElement).color,
        }));
      })();

      // Act — the corpus, then a reader clicking every link and the submit button inside it.
      await page.goto(`${server.url.origin}/?case=fragment-xss`);
      await page.waitForSelector('[data-fy-render-fragment="true"]');
      await page.waitForTimeout(800);
      const inside = await page.evaluate(() => {
        const root = (window as unknown as { __fyRoots: ShadowRoot[] }).__fyRoots[0] as ShadowRoot;
        for (const id of ['js', 'rel', 'submit']) (root.getElementById(id) as HTMLElement | null)?.click();
        const host = document.querySelector('[data-fy-render-fragment="true"]') as HTMLElement;
        const overlay = root.getElementById('overlay')?.getBoundingClientRect();
        const box = host.getBoundingClientRect();
        return {
          elements: Array.from(root.querySelectorAll('*')).map(element => element.nodeName.toLowerCase()),
          ok: root.getElementById('ok')?.textContent ?? null,
          overlayInside:
            overlay === undefined ||
            (overlay.top >= box.top - 1 && overlay.bottom <= box.bottom + 1 && overlay.height <= box.height + 1),
        };
      });
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        outside: getComputedStyle(document.getElementById('outside') as HTMLElement).color,
        pwned: (window as unknown as { __fyPwned?: string }).__fyPwned ?? null,
        url: location.pathname + location.search,
      }));

      // Assert — it rendered.
      should(inside.ok).equal('fragment rendered');
      // NOTHING RUNS, before or after the clicks, and the page never navigated.
      should(after.pwned).be.null();
      should(after.url).equal('/?case=fragment-xss');
      for (const refused of [
        'script',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'button',
        'meta',
        'link',
        'base',
        'foreignobject',
        'use',
      ])
        should(inside.elements).not.containEql(refused);
      // NOTHING LOADS.
      should(ledger.filter(path => path.startsWith('/beacon'))).eql([]);
      // NOTHING ESCAPES: the host page's styles are what they were before the fragment arrived.
      should(after).containEql({ body: before.body, outside: before.outside });
      should(inside.overlayInside).be.true();
      // And the sanitizer's own parse ran under the one dedicated policy, without a violation.
      should(violations).eql([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
