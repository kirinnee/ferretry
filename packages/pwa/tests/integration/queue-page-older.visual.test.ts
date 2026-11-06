/**
 * THE QUEUE PAGE OVER A LONG HISTORY, in a real browser.
 *
 * The machine answers a window (the newest page and every message still waiting) and the older history only
 * when asked, by cursor. The scene (`tests/integration/fixtures/queue-page-scene.tsx`) is the real
 * `QueuePageView` over the real row and history functions with a fake machine behind them. Nothing the owner
 * could see may be lost: a message still waiting from long ago is on the first page, and "Show older
 * messages" adds each older message once until the oldest is shown and the button goes.
 *
 * Set `FY_QUEUE_SHOTS_DIR` to keep the first page and the page after loading older messages, at a phone and a
 * desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_QUEUE_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { height: 100%; margin: 0; }';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-queue-page-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/queue-page-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the queue page scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });

const open = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${mode}`);
  await tab.waitForSelector('[data-queue-page]');
  return tab;
};

const rowCount = async (tab: Page): Promise<number> => await tab.locator('[data-queue-row]').count();

describe('the queue page over a long history', () => {
  it('shows the window first, with the long-waiting messages in it, and an older button', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await open(context, 'light');
      // 12 newest plus the two still waiting from long ago.
      expect(await rowCount(tab)).toBe(14);
      expect(await tab.locator('[data-queue-row][data-queue-state="queued"]').count()).toBe(2);
      expect(await tab.locator('[data-queue-older]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('adds each older page once and drops the button at the oldest message', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'light');
      const seen: number[] = [await rowCount(tab)];
      while ((await tab.locator('[data-queue-older]').count()) === 1) {
        await tab.locator('[data-queue-older]').click();
        seen.push(await rowCount(tab));
      }
      // 54 messages, none repeated or missing, in pages of 12 past the first.
      expect(seen.at(-1)).toBe(54);
      expect(new Set(seen).size).toBe(seen.length);
      expect(
        await tab.evaluate(() => (window as unknown as { __queuePage: { reads: string[] } }).__queuePage.reads.length),
      ).toBe(seen.length - 1);
    } finally {
      await context.close();
    }
  });
});

describe('the queue page, captured', () => {
  it.if(shotsDir !== '')(
    'keeps the first page and the page after older messages, at a phone and a desktop, light and dark',
    async () => {
      for (const phone of [false, true])
        for (const mode of ['light', 'dark'] as const) {
          const context = await newContext(phone, mode);
          try {
            const tab = await open(context, mode);
            const name = `queue-${phone ? 'phone' : 'desktop'}-${mode}`;
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `${name}-first-page.png`) });
            await tab.locator('[data-queue-older]').click();
            await tab.locator('[data-queue-older]').click();
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `${name}-after-older.png`) });
          } finally {
            await context.close();
          }
        }
    },
    120_000,
  );
});
