/**
 * SETTINGS › APPEARANCE › "OPEN LINKS IN", in a real browser. The scene
 * (`tests/integration/fixtures/open-links-scene.tsx`) is the real Settings page and the real transcript
 * over one stored device setting, so these prove the whole path: the row a reader sees, the choice it
 * stores, and where a tapped chat link then goes — a new tab by default, the side panel when chosen,
 * and a new tab again for a Cmd/Ctrl-click whatever is chosen.
 *
 * Every request leaves for this test's own server or is refused: the chat's link points back at it.
 *
 * Set `FY_OPEN_LINKS_SHOTS_DIR` to keep the row and the open panel at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import { boundedContext, overlapped } from '../support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_OPEN_LINKS_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; padding: 8px; position: fixed; }
`;
const GUIDE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Setup guide</title></head><body style="font-family: system-ui; padding: 24px"><h1>Setup guide</h1><p>Pair a phone from Settings › This device.</p></body></html>`;

let browser: Browser;
const overlap = overlapped();
const bounded = boundedContext(() => browser, 4);
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-open-links-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/open-links-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the open-links scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/guide') return new Response(GUIDE_HTML, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

beforeAll(overlap.start);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await bounded({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, query: string, hash = ''): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?${query}${hash}`);
  return tab;
};

const openSettings = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await open(context, `view=settings&theme=studio-${mode}`, '#appearance');
  await tab.waitForSelector('[data-setting-id="open-links-in"]');
  return tab;
};

const openChat = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await open(context, `theme=studio-${mode}`);
  await tab.waitForSelector('.md a');
  return tab;
};

const chooseSidePanel = async (tab: Page): Promise<void> => {
  await tab.locator('[data-setting-id="open-links-in"] label', { hasText: 'Ferretry side panel' }).click();
};

const guideLink = (tab: Page) => tab.locator('.md a', { hasText: 'the setup guide' });

describe('Settings › Appearance › Open links in', () => {
  overlap.it('shows the plain two-way row, Your browser first and chosen', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await openSettings(context, 'light');
      const row = tab.locator('[data-setting-id="open-links-in"]');
      expect(await row.innerText()).toContain('Open links in');
      expect(await row.innerText()).toContain('Cmd/Ctrl-click always opens a new tab.');
      const radios = row.locator('input[type="radio"]');
      expect(await radios.count()).toBe(2);
      expect(await radios.nth(0).isChecked()).toBe(true);
      expect(await row.locator('label').allInnerTexts()).toEqual(['Your browser', 'Ferretry side panel']);
    } finally {
      await context.close();
    }
  });
});

describe('a chat link', () => {
  overlap.it('opens a new browser tab by default', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await openChat(context, 'light');
      expect(await tab.locator('[data-open-links-in]').getAttribute('data-open-links-in')).toBe('browser');
      const [popup] = await Promise.all([context.waitForEvent('page'), guideLink(tab).click()]);
      await popup.waitForLoadState();
      expect(popup.url()).toBe(`${server?.url.origin}/guide`);
      expect(await tab.locator('aside').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  overlap.it(
    'opens the side panel beside the chat on a desktop once it is chosen, and a Cmd/Ctrl-click still opens a tab',
    async () => {
      const context = await newContext(false, 'light');
      try {
        await chooseSidePanel(await openSettings(context, 'light'));
        const tab = await openChat(context, 'light');
        expect(await tab.locator('[data-open-links-in]').getAttribute('data-open-links-in')).toBe('panel');

        const pages = context.pages().length;
        await guideLink(tab).click();
        const pane = tab.locator('aside');
        await pane.waitFor();
        expect(await pane.innerText()).toContain(`${server?.url.origin}/guide`);
        // Beside, not over: the conversation keeps its width to the pane's left.
        const chat = await tab.locator('.kt-chat-surface').boundingBox();
        const side = await pane.boundingBox();
        expect(chat !== null && side !== null && chat.x + chat.width <= side.x).toBe(true);
        expect(context.pages().length).toBe(pages);

        const [popup] = await Promise.all([
          context.waitForEvent('page'),
          guideLink(tab).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] }),
        ]);
        await popup.waitForLoadState();
        expect(popup.url()).toBe(`${server?.url.origin}/guide`);
      } finally {
        await context.close();
      }
    },
  );

  overlap.it('opens the side panel as a sheet on a phone', async () => {
    const context = await newContext(true, 'light');
    try {
      await chooseSidePanel(await openSettings(context, 'light'));
      const tab = await openChat(context, 'light');
      await guideLink(tab).click();
      const sheet = tab.getByRole('dialog');
      await sheet.waitFor();
      expect(await sheet.innerText()).toContain(`${server?.url.origin}/guide`);
      expect(await tab.locator('aside').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe('Open links in, captured', () => {
  it.if(shotsDir !== '')(
    'keeps the row and the open side panel at a phone and a desktop, light and dark',
    async () => {
      for (const phone of [false, true])
        for (const mode of ['light', 'dark'] as const) {
          const context = await newContext(phone, mode);
          const size = phone ? 'phone' : 'desktop';
          try {
            const settings = await openSettings(context, mode);
            await chooseSidePanel(settings);
            const row = settings.locator('[data-setting-id="open-links-in"]');
            await row.scrollIntoViewIfNeeded();
            await settings.waitForTimeout(150);
            await settings.screenshot({ path: join(shotsDir, `open-links-setting-${size}-${mode}.png`) });

            const chat = await openChat(context, mode);
            await guideLink(chat).click();
            await (phone ? chat.getByRole('dialog') : chat.locator('aside')).waitFor();
            await chat.waitForTimeout(400);
            await chat.screenshot({ path: join(shotsDir, `open-links-panel-${size}-${mode}.png`) });
          } finally {
            await context.close();
          }
        }
    },
    180_000,
  );
});
