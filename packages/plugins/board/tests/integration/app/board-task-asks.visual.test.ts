/**
 * THE BOARD AND A CARD'S "AGENDA ASKS", in a real browser: the board (`/d/<id>/board`) draws, a card opens over it
 * (`/d/<id>/board/F3`: a drawer on a desktop, a page on a phone) and its page has the "Agenda asks" section (v4 parity).
 * Phone and desktop, light and dark. Set `FY_BOARD_APP_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_BOARD_APP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-board-app-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/board-card-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the board scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_280, height: 800 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: 'phone' | 'desktop',
  scheme: 'light' | 'dark',
  query: string,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  return { tab, close: async () => await context.close() };
};

describe('the board and a card’s Agenda asks', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`draws the board's cards (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '&open=none');
        try {
          // A phone shows one lane at a time: wait for any of the cards.
          await tab.waitForSelector(
            'text=/Rich CI cache summary|Release notes for 4.111|Retire the old inbox route|Lane editor copy/',
          );
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-board.png`) });
        } finally {
          await close();
        }
      }, 60_000);

      it(`draws the card with its Agenda asks section (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '&open=F3');
        try {
          await tab.waitForSelector('[data-section="asks"] [data-ask-open]');
          const rows = await tab.$$eval('[data-section="asks"] li', items => items.map(item => item.textContent));
          expect(rows).toEqual([
            'Blocking · OK to build? Rich CI cache summary',
            'Answered · Which cache layout? · Per-job layout',
          ]);
          const box = await tab.$eval('[data-section="asks"]', element => {
            const { left, right } = element.getBoundingClientRect();
            return { left, right, width: window.innerWidth };
          });
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(box.width);
          await tab.$eval('[data-section="asks"]', element => element.scrollIntoView({ block: 'center' }));
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-card-agenda-asks.png`) });
        } finally {
          await close();
        }
      }, 60_000);
    }
});
