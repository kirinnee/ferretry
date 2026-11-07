/**
 * THE INBOX SHOWS EACH CARD ONCE, in a real browser: on the Snoozed tab, a card that is both a (snoozed) gate item and a
 * card to test is one row, and a card with no gate item keeps its row. Phone 390 and desktop 1440, light and dark.
 *
 * Set `FY_INBOX_CARD_ONCE_SHOTS_DIR` to keep `<viewport>-<scheme>-snoozed.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/hromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_CARD_ONCE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-card-once-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-card-once-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the card-once scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('the Inbox shows each card once', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`lists the snoozed gate card once and keeps the plain card's row (${viewport.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        try {
          const tab = await context.newPage();
          await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-agenda-filter] [aria-haspopup="menu"]', { timeout: 5_000 });
          await tab.click('[data-agenda-filter] [aria-haspopup="menu"]');
          await tab.click('[data-agenda-filter-option="snoozed"]');
          await tab.waitForSelector('.fy-parked-row', { timeout: 4_000 });
          const titles = await tab.$$eval('.fy-parked-row', rows => rows.map(row => row.textContent ?? ''));
          expect(titles.filter(text => text.includes('Duplicate gate items on reassign'))).toHaveLength(1);
          expect(titles.filter(text => text.includes('Warden revives dead ferrets'))).toHaveLength(1);
          expect(await tab.$$('[data-to-test-snoozed]')).toHaveLength(1);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-snoozed.png`) });
        } finally {
          await context.close();
        }
      });
});
