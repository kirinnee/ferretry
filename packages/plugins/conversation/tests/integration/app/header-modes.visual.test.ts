/**
 * A FERRET'S HEADER IS THE NAME AND THE STATUS, in a real browser, over fake data (`fixtures/header-modes-scene.tsx`):
 * Conversation's real chat and Modes menu. The main line carries no mode; Modes opens every one of them, inside the
 * window, at 1280 and 390, light and dark.
 *
 * Set `FY_HEADER_MODES_SHOTS_DIR` to keep `<viewport>-<scheme>-<closed|open>.png` (and `-before`, the old toolbar).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HEADER_MODES_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-header-modes-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/header-modes-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the header scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('a ferret’s header', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`shows no mode on its main line and opens every one behind Modes (${viewport.name}, ${scheme})`, async () => {
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
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        const shot = async (name: string) => {
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`) });
        };
        try {
          if (shotsDir !== '') {
            await tab.goto(`${origin}/?theme=studio-${scheme}&modes=toolbar`);
            await tab.waitForSelector('[data-ferret-header]', { timeout: 8_000 });
            await tab.waitForTimeout(300);
            await shot('before');
          }
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          try {
            await tab.waitForSelector('[data-modes-trigger]', { timeout: 8_000 });
          } catch (error) {
            throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
          }
          await tab.waitForTimeout(300);
          const closed = await tab.evaluate(() => {
            const header = document.querySelector<HTMLElement>('[data-ferret-header]');
            return {
              text: header?.textContent ?? '',
              height: Math.round(header?.getBoundingClientRect().height ?? 0),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          for (const word of ['Muriel', 'running', 'Modes'])
            expect(closed.text, `${word} is on the main line`).toContain(word);
          for (const word of ['Agenda mode', 'Hypermedia', 'Passive lessons', 'Compact memory', 'Scan this ferret'])
            expect(closed.text, `${word} is not on the main line`).not.toContain(word);
          expect(closed.height, 'the header is one line').toBeLessThan(64);
          expect(closed.overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
          await shot('closed');

          await tab.click('[data-modes-trigger]');
          await tab.waitForSelector('[data-modes-body] [data-hypermedia-switch]', { timeout: 8_000 });
          await tab.waitForTimeout(400);
          const open = await tab.evaluate(() => {
            const body = document.querySelector<HTMLElement>('[data-modes-body]');
            const box = body?.getBoundingClientRect();
            return {
              text: body?.textContent ?? '',
              inside:
                box !== undefined &&
                box.left >= 0 &&
                box.right <= window.innerWidth + 1 &&
                box.top >= 0 &&
                box.bottom <= window.innerHeight + 1,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          for (const word of ['Agenda mode', 'Hypermedia', 'Passive lessons', 'Compact memory', 'Scan this ferret'])
            expect(open.text, `${word} is in the menu`).toContain(word);
          expect(open.inside, 'the menu is inside the window').toBe(true);
          expect(open.overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
          await shot('open');
        } finally {
          await context.close();
        }
      });
});
