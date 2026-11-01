/**
 * THE INBOX CARD'S TEXT CAN BE HIGHLIGHTED AND ITS COMPOSER HAS THE MIC, in a real browser, on a phone and a desktop,
 * in light and dark.
 *
 * The owner (2026-11-01, &B127): "inbox texts can't be highlighted. inbox's composer doesn't have the voice option!"
 *
 *  - The swipe deck's card text computes `user-select: text`; a double click highlights a word of it; its buttons stay
 *    `user-select: none`.
 *  - The Inbox composer draws the chat composer's mic (a "Dictat…" button; the label says unavailable where the browser cannot).
 *
 * Set `FY_INBOX_TEXT_VOICE_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_TEXT_VOICE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-text-voice-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-text-voice-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox text/voice scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (name: string, scheme: 'light' | 'dark'): Promise<{ tab: Page; close: () => Promise<void> }> => {
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
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  tab.on('console', message => message.type() === 'error' && problems.push(message.text()));
  await tab.goto(`${origin}/?theme=studio-${scheme}`);
  try {
    await tab.waitForSelector('.fy-attn-deck__top', { timeout: 4_000 });
    await tab.waitForSelector('button[aria-label^="Dictat"]', { timeout: 4_000 });
  } catch (error) {
    throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

describe('the Inbox card’s text and composer', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      const label = `${name}, ${scheme}`;

      it(`lets the card’s text be highlighted, and keeps its buttons unhighlightable (${label})`, async () => {
        const { tab, close } = await open(name, scheme);
        try {
          const found = await tab.evaluate(() => {
            const select = (element: Element) => getComputedStyle(element).userSelect;
            const top = document.querySelector('.fy-attn-deck__top') as HTMLElement;
            const text = top.querySelector('.fy-attn-card__title, [data-agenda-title]') as HTMLElement;
            const button = top.querySelector('button') as HTMLElement;
            return { top: select(top), text: select(text), button: select(button) };
          });
          expect(found.top).toBe('text');
          expect(found.text).toBe('text');
          expect(found.button).toBe('none');
          await tab
            .getByText('Each login has a limit')
            .first()
            .click({ clickCount: 3, position: { x: 12, y: 8 } });
          const selected = await tab.evaluate(() => window.getSelection()?.toString() ?? '');
          expect(selected, 'the paragraph is highlighted').toContain('Each login has a limit');
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-card-text-selected.png`) });
        } finally {
          await close();
        }
      });

      it(`draws the chat composer’s mic in the Inbox composer (${label})`, async () => {
        const { tab, close } = await open(name, scheme);
        try {
          expect(await tab.locator('button[aria-label^="Dictat"]').count()).toBe(1);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-composer-mic.png`) });
        } finally {
          await close();
        }
      });
    }
});
