/**
 * THE PERMISSION AND DIALOG CARDS, in a real browser, over fixed fake data (no real name, path or code). The scene
 * (`fixtures/prompt-cards-scene.tsx`) draws the real cards in the chat's input column. Each must keep every answer a 44px
 * target, stay inside the screen and wrap on a phone, in light and dark.
 *
 * Set `FY_PROMPT_CARDS_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROMPT_CARDS_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-log { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 16px; width: 100%; box-sizing: border-box; }
  .fy-chat-input__column { margin: 0 auto; max-width: 760px; padding: 0 16px 16px; width: 100%; box-sizing: border-box; }
  .scene-composer { border: 1px solid var(--border); border-radius: 12px; color: var(--muted); min-height: 52px; padding: 14px; }
`;

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-prompt-cards-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/prompt-cards-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the prompt-cards scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, card: string, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?card=${card}&theme=studio-${mode}`);
  await tab.waitForSelector('.fy-prompt-card');
  return tab;
};

describe('the permission and dialog cards above the composer', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`keep every answer a 44px target inside the screen at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'both', mode);
        const buttons = tab.locator('.fy-prompt-card button');
        expect(await buttons.count()).toBe(5);
        for (let at = 0; at < 5; at += 1) {
          const box = await buttons.nth(at).boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        }
        const cards = tab.locator('.fy-prompt-card');
        for (let at = 0; at < 2; at += 1) {
          const box = await cards.nth(at).boundingBox();
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        }
        // The cards sit above the composer, never over it.
        const lastCard = await cards.nth(1).boundingBox();
        const composer = await tab.locator('.scene-composer').boundingBox();
        expect((lastCard?.y ?? 0) + (lastCard?.height ?? 0)).toBeLessThanOrEqual(composer?.y ?? 0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `cards-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

  it('answers on a tap: the card says it is waiting, and its buttons are disabled', async () => {
    const context = await newContext(VIEWPORTS[0], 'light');
    const tab = await open(context, 'permission', 'light');
    await tab.locator('[data-permission-option="1"]').click();
    await tab.getByText('Answered, waiting for denisha to continue.').waitFor();
    expect(await tab.locator('[data-permission-option="1"]').isDisabled()).toBe(true);
    if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, 'permission-answered-phone-390-light.png') });
    await context.close();
  }, 60_000);
});
