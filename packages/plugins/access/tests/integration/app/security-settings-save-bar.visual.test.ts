/**
 * THE SECURITY SETTINGS' Save bar covers nothing at any scroll position (C59 O11 R6: it rode over a row in the first view at 1440 and
 * floated above the scroll area's padding). It is in flow at the end of its form, so at every scroll position no row of the page
 * overlaps it, and at the end of the page it rests directly under the last row (`fixtures/security-settings-scene.tsx`), in a real
 * browser on a phone and a desktop, light and dark, over fake data. Set `FY_SECURITY_SHOTS_DIR` to keep `<viewport>-<scheme>-<where>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SECURITY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-security-scene-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/security-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '1440-short', width: 1_440, height: 420, phone: false },
  { name: '390', width: 390, height: 420, phone: true },
] as const;

describe('the Security settings Save bar', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`covers no row at any scroll position (${viewport.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-security-save]', { timeout: 15_000 });
          // The bar overlaps nothing at any scroll position: walk the page in steps and, at each, test the bar against every row.
          const overlaps = await tab.evaluate(async () => {
            const scroller = document.querySelector('[data-scene-scroll]') as HTMLElement;
            const found: string[] = [];
            const check = (at: number): void => {
              const bar = (document.querySelector('[data-setting-savebar]') as HTMLElement).getBoundingClientRect();
              for (const row of document.querySelectorAll('[data-security-settings] ul > li')) {
                const box = row.getBoundingClientRect();
                const across = Math.min(bar.bottom, box.bottom) - Math.max(bar.top, box.top);
                if (across > 1) found.push(`${at}: ${(row.textContent ?? '').slice(0, 30)} (${Math.round(across)}px)`);
              }
            };
            for (let at = 0; at <= scroller.scrollHeight; at += 60) {
              scroller.scrollTo(0, at);
              await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
              check(at);
            }
            return found;
          });
          expect(overlaps).toEqual([]);
          const bar = await tab.evaluate(() => {
            const scroller = document.querySelector('[data-scene-scroll]');
            scroller?.scrollTo(0, scroller.scrollHeight);
            const box = (document.querySelector('[data-setting-savebar]') as HTMLElement).getBoundingClientRect();
            const rows = [...document.querySelectorAll('[data-security-settings] ul > li')];
            const last = rows.at(-1)?.getBoundingClientRect();
            return {
              position: getComputedStyle(document.querySelector('[data-setting-savebar]') as HTMLElement).position,
              gap: box.top - (last?.bottom ?? 0),
            };
          });
          expect(bar.position).toBe('static');
          // Directly under the last row, with no room reserved between them.
          expect(Math.abs(bar.gap)).toBeLessThanOrEqual(1.5);
          if (shotsDir !== '') {
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-end.png`) });
            await tab.evaluate(() => document.querySelector('[data-scene-scroll]')?.scrollTo(0, 0));
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-top.png`) });
          }
        } finally {
          await context.close();
        }
      });

  // The other half of the rule: while something is UNSAVED the bar sticks to the foot, so a long form never loses its Save.
  for (const viewport of VIEWPORTS)
    it(`keeps Save in view while there are unsaved changes, even scrolled up to the form's first rows (${viewport.name})`, async () => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.phone ? 2 : 1,
        hasTouch: viewport.phone,
        isMobile: viewport.phone,
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=studio-light`);
        await tab.waitForSelector('[data-security-save]', { timeout: 15_000 });
        // Clean at the first view: the bar rests in flow (below the fold on a short window), covering nothing.
        expect(
          await tab.evaluate(
            () => getComputedStyle(document.querySelector('[data-setting-savebar]') as HTMLElement).position,
          ),
        ).toBe('static');
        await tab.locator('[data-setting-saves="on-save"] input[type="number"]').first().fill('9');
        await tab.waitForSelector('[data-setting-savebar][data-state="dirty"]');
        // Scrolled up so only the TOP of the form is on screen (its own foot is far below): the bar still stays in reach.
        await tab.evaluate(() => {
          const group = document.querySelector('[data-setting-saves="on-save"]') as HTMLElement | null;
          document.querySelector('[data-scene-scroll]')?.scrollTo(0, (group?.offsetTop ?? 0) - 40);
        });
        await tab.waitForTimeout(100);
        const seen = await tab.evaluate(() => {
          const bar = document.querySelector('[data-setting-savebar]') as HTMLElement;
          const box = bar.getBoundingClientRect();
          return {
            position: getComputedStyle(bar).position,
            top: box.top,
            bottom: box.bottom,
            height: window.innerHeight,
          };
        });
        expect(seen.position).toBe('sticky');
        expect(seen.top).toBeGreaterThanOrEqual(0);
        expect(seen.bottom).toBeLessThanOrEqual(seen.height + 1);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-light-dirty-top.png`) });
      } finally {
        await context.close();
      }
    });
});
