/**
 * CANCELLED ROWS DO NOT BLOCK THE CHAT, in a real browser (owner: "there are messages stuck at the
 * bottom (cancelled) status — is there no way to get rid of it? it blocks the whole experience").
 *
 * The scene (`tests/integration/fixtures/cancelled-rows-scene.tsx`) is the real `Transcript` over the
 * real `placeLedgerRows`. A send that was cancelled or given up on must sit in the timeline at its send
 * time as a slim note, never below the live conversation, and a Dismiss must remove it.
 *
 * Set `FY_CANCELLED_SHOTS_DIR` to keep the scene at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_CANCELLED_SHOTS_DIR ?? '';
const tag = process.env.FY_CANCELLED_SHOTS_TAG ?? 'after';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-cancelled-rows-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/cancelled-rows-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the cancelled-rows scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const open = async (context: BrowserContext, query: string): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?${query}`);
  await tab.waitForSelector('.fy-transcript-content');
  return tab;
};

/** The order the reader's messages appear in, top to bottom, by the words each shows. */
const order = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    [...document.querySelectorAll('[data-transcript-kind]')].map(node => (node.textContent ?? '').slice(0, 40)),
  );

describe('cancelled and given-up sends sit in the timeline, not under it', () => {
  it('places each note at its send time, above the later conversation', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await open(context, 'theme=studio-light');
      const rows = await order(tab);
      const index = (words: string): number => rows.findIndex(text => text.includes(words));
      expect(index('hi')).toBeGreaterThan(index('Two tests time out'));
      expect(index('hi')).toBeLessThan(index('Ship the retry fix'));
      expect(index('bump the retry')).toBeLessThan(index('Thanks, tell me'));
      expect(rows.at(-1)).toContain('Will do');
      expect(await tab.locator('[data-settled-note]').count()).toBe(2);
      expect(await tab.locator('[data-settled-note="cancelled"]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('removes a note when Dismiss is pressed', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light');
      await tab.locator('[data-settled-note="cancelled"] [data-settled-dismiss]').click();
      expect(await tab.locator('[data-settled-note="cancelled"]').count()).toBe(0);
      expect(await tab.locator('[data-settled-note]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('opens a note to the whole message and folds it again', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light');
      await tab.locator('[data-settled-note] .fy-settled-open').last().click();
      await tab.locator('[data-ledger-more]').click();
      expect(await tab.locator('[data-menu-key="hide"]').count()).toBe(1);
      await tab.locator('[data-menu-key="hide"]').click();
      expect(await tab.locator('[data-settled-note]').count()).toBe(2);
    } finally {
      await context.close();
    }
  });
});

describe('the cancelled rows, captured', () => {
  it.if(shotsDir !== '')(
    'keeps the scene at a phone and a desktop, light and dark',
    async () => {
      for (const phone of [false, true])
        for (const mode of ['light', 'dark'] as const)
          for (const state of ['list', 'open', 'dismissed'] as const) {
            const context = await newContext(phone, mode);
            try {
              const query = `theme=studio-${mode}${state === 'open' ? '&open=1' : ''}${state === 'dismissed' ? '&dismissed=1' : ''}`;
              const tab = await open(context, query);
              await tab.waitForTimeout(150);
              await tab.screenshot({
                path: join(shotsDir, `cancelled-${tag}-${state}-${phone ? 'phone' : 'desktop'}-${mode}.png`),
              });
            } finally {
              await context.close();
            }
          }
    },
    120_000,
  );
});
