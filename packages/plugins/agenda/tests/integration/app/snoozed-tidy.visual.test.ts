/**
 * SNOOZED ROWS ARE TIDY, in a real browser, on a phone (390) and a desktop (1440).
 *
 * Each snoozed row carries a small Unsnooze action at its right edge (never a full-width button under it), a
 * pointer resting on the first row underlines nothing, and nothing scrolls sideways.
 *
 * Set `FY_SNOOZED_TIDY_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/hromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_SNOOZED_TIDY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-snoozed-tidy-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/snoozed-tidy-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox find scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

describe('Snoozed rows are tidy', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`lists each row with a small Unsnooze at its edge (${viewport.name}, ${scheme})`, async () => {
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
          await tab.waitForSelector('[data-agenda-filter] [aria-haspopup="menu"]', { timeout: 15_000 });
          await tab.click('[data-agenda-filter] [aria-haspopup="menu"]');
          await tab.click('[data-agenda-filter-option="snoozed"]');
          await tab.waitForSelector('[data-agenda-parked]', { timeout: 15_000 });

          const rows = await tab.$$eval('.fy-parked-row', nodes =>
            nodes.map(node => {
              const link = node.querySelector('.fy-parked-row__link')?.getBoundingClientRect();
              const back = node.querySelector('[data-agenda-unsnooze]')?.getBoundingClientRect();
              const box = node.getBoundingClientRect();
              return {
                box: box.height,
                link: link?.height ?? 0,
                backWidth: back?.width ?? 0,
                backTop: back?.top ?? 0,
                top: box.top,
                width: box.width,
              };
            }),
          );
          expect(rows.length).toBeGreaterThanOrEqual(6);
          const wrapped = await tab.$$eval(
            '.fy-parked-row .fy-inbox-row__meta',
            nodes => nodes.filter(node => node.getBoundingClientRect().height > 24).length,
          );
          expect(wrapped, 'the meta line of a short row stays on one line').toBeLessThanOrEqual(1);
          for (const row of rows) {
            expect(row.backWidth, 'the action is small, not full width').toBeLessThan(row.width * 0.4);
            expect(row.backWidth, 'the action is a compact icon').toBeLessThanOrEqual(48);
            expect(row.box, 'the action sits beside the row, not under it').toBeLessThanOrEqual(row.link + 1);
          }

          // A pointer resting on the first row: the row may fill, but no text is underlined.
          if (!viewport.phone) await tab.hover('.fy-parked-row__link');
          const decorations = await tab.$$eval('.fy-parked-row__link, .fy-parked-row__link *', nodes =>
            nodes.map(node => getComputedStyle(node).textDecorationLine),
          );
          for (const line of decorations) expect(line, 'no row text is underlined').toBe('none');

          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `snoozed-${viewport.name}-${scheme}.png`) });
        } finally {
          await context.close();
        }
      }, 60_000);
});
