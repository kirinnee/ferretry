/**
 * "USE THE BOARD", in a real browser (docs/board.md § The board is opt-in; owner: "board is overkill — most
 * ferrets should not use tasks or boards — ask before doing that").
 *
 * The scene (`tests/integration/fixtures/board-switch-scene.tsx`) is the real `ProjectBoardSwitch` over an
 * in-memory client. The switch must read as a switch, flip on a tap, keep its state and say why when the
 * machine refuses, and tell an old machine from an off board.
 *
 * Set `FY_BOARD_SWITCH_SHOTS_DIR` to keep the scene at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_BOARD_SWITCH_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-board-switch-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/board-switch-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the board-switch scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  await tab.waitForSelector('[data-scene="refused"] [role="switch"]');
  return tab;
};

const checked = async (tab: Page, scene: string): Promise<string | null> =>
  await tab.locator(`[data-scene="${scene}"] [role="switch"]`).getAttribute('aria-checked');

describe('the Use the board switch', () => {
  it('flips on a tap, and keeps its state with the reason when the machine refuses', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light');
      expect(await checked(tab, 'ratchet')).toBe('false');
      expect(await checked(tab, 'ferretry')).toBe('true');
      await tab.locator('[data-scene="ratchet"] [role="switch"]').click();
      await tab.waitForSelector('[data-scene="ratchet"] [data-project-board-switch="on"]');
      expect(await tab.locator('[data-scene="ratchet"]').innerText()).toContain('You set this.');

      await tab.locator('[data-scene="refused"] [role="switch"]').click();
      await tab.waitForSelector('[data-scene="refused"] [role="alert"]');
      expect(await checked(tab, 'refused')).toBe('false');
      expect(await tab.locator('[data-scene="old-machine"] [data-project-board-switch="missing"]').count()).toBe(1);
      const box = await tab.locator('[data-scene="ratchet"] [role="switch"]').boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it('keeps the scene at a phone and a desktop, light and dark', async () => {
    if (shotsDir === '') return;
    for (const phone of [true, false])
      for (const mode of ['light', 'dark'] as const) {
        const context = await newContext(phone, mode);
        try {
          const tab = await open(context, `theme=studio-${mode}`);
          await tab.screenshot({ path: join(shotsDir, `board-switch-${phone ? 'phone' : 'desktop'}-${mode}.png`) });
        } finally {
          await context.close();
        }
      }
  }, 120_000);
});
