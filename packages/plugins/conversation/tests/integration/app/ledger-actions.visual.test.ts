/**
 * A SEND'S ACTIONS LIVE IN ONE SMALL MENU, in a real browser (owner: "make the retry etc button not so
 * damn huge — make it a small button that opens a context menu so we can choose to cancel or whatnot").
 *
 * The scene (`tests/integration/fixtures/ledger-actions-scene.tsx`) is the real `Transcript` with one send
 * in each state a send can be stuck in. Each state must keep its normal bubble height, offer a "Message
 * actions" button with a 44px hit area, and open a menu that stays inside the screen.
 *
 * Set `FY_LEDGER_ACTIONS_SHOTS_DIR` to keep each state at 390 and 412 wide phones and a desktop, light and
 * dark, closed and with the menu open. `FY_LEDGER_ACTIONS_SHOTS_TAG` names the set (`before` / `after`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_LEDGER_ACTIONS_SHOTS_DIR ?? '';
const tag = process.env.FY_LEDGER_ACTIONS_SHOTS_TAG ?? 'after';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

const STATES = ['sending', 'typed', 'unconfirmed', 'revived', 'failed', 'cancelled'] as const;
const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'phone-412', width: 412, height: 915, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ledger-actions-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/ledger-actions-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ledger-actions scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const newContext = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    reducedMotion,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, state: string, mode: 'light' | 'dark'): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  const tab = await context.newPage();
  await tab.goto(`${origin}/?state=${state}&theme=studio-${mode}`);
  await tab.waitForSelector('.fy-transcript-content');
  return tab;
};

/** Checks one send state's button and menu in a page that has already opened it. */
const checkState = async (tab: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> => {
  const button = tab.getByRole('button', { name: 'Message actions' });
  expect(await button.count()).toBe(1);
  expect(await tab.locator('[data-ledger-actions]').count()).toBe(0);
  const box = await button.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(30);
  const hit = await button.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const after = getComputedStyle(node, '::after');
    return {
      width: Math.max(rect.width, Number.parseFloat(after.width)),
      height: Math.max(rect.height, Number.parseFloat(after.height)),
    };
  });
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const menu = tab.getByRole('menu', { name: 'Message actions' });
  await menu.waitFor();
  const bounds = await menu.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
  await tab.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  expect(await tab.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Message actions');
};

/** Two lanes, each its own browser profile, take alternate states; failures are reported lane 0 first. */
const LANES = 2;

describe('a send’s actions are one small button', () => {
  for (const viewport of VIEWPORTS) {
    it(`keeps every state's button small, tappable and its menu on screen at ${viewport.name}`, async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: LANES }, async (_, lane) => {
          const context = await newContext(viewport, 'light');
          try {
            const tab = await context.newPage();
            for (const [index, state] of STATES.entries()) {
              if (index % LANES !== lane) continue;
              try {
                await tab.goto(`${server?.url.origin ?? ''}/?state=${state}&theme=studio-light`);
                await tab.waitForSelector('.fy-transcript-content');
                await checkState(tab, viewport);
              } catch (error) {
                if (error instanceof Error) error.message = `[${state}] ${error.message}`;
                throw error;
              }
            }
          } finally {
            await context.close();
          }
        }),
      );
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    }, 120_000);
  }
});

describe('the ledger actions, captured', () => {
  it.if(shotsDir !== '')(
    'keeps each state at a phone and a desktop, light and dark, closed and open',
    async () => {
      for (const viewport of VIEWPORTS)
        for (const mode of ['light', 'dark'] as const)
          for (const state of STATES) {
            const context = await newContext(viewport, mode);
            try {
              const tab = await open(context, state, mode);
              await tab.waitForTimeout(150);
              const name = `ledger-${tag}-${state}-${viewport.name}-${mode}`;
              await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
              const button = tab.getByRole('button', { name: 'Message actions' });
              if ((await button.count()) > 0) {
                await button.click();
                await tab.waitForTimeout(100);
                await tab.screenshot({ path: join(shotsDir, `${name}-menu.png`) });
              }
            } finally {
              await context.close();
            }
          }
    },
    600_000,
  );
});
