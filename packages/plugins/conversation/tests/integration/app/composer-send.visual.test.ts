/**
 * THE FERRET PAGE'S COMPOSER CAN SEND, in a real browser (ferret-page-send, item 1; the sweep found Send painted outside
 * the visible strip, a click that timed out, and Enter that did nothing).
 *
 * The scene (`fixtures/composer-send-scene.tsx`) is the REAL `Composer` in the chat page's own column structure, inside the
 * `main` that clips its overflow, over a fake daemon that records every send. At the sweep's two windows and a phone:
 *
 *  - the Send button is INSIDE the window (all of it), takes a real click, and the click sends the typed words;
 *  - on a desktop, Enter in the box sends them too;
 *  - the box keeps most of the row: the composer is one compact line high, never a column that outgrows the window.
 *
 * Set `FY_COMPOSER_SEND_SHOTS_DIR` to keep `<viewport>-<mode>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_COMPOSER_SEND_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-composer-send-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/composer-send-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the composer send scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const WINDOWS = [
  { name: '1280x713', width: 1_280, height: 713, phone: false },
  { name: '1440x900', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const open = async (size: (typeof WINDOWS)[number], mode: 'light' | 'dark') => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: mode,
    deviceScaleFactor: size.phone ? 2 : 1,
    ...(size.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}/?theme=studio-${mode}${size.phone ? '&compact=1' : ''}`);
  await tab.waitForSelector('[data-composer-send]');
  return { tab, close: async () => await context.close() };
};

const sentOf = async (tab: Page): Promise<readonly { readonly message: string }[]> =>
  await tab.evaluate(() => (window as unknown as { __sent: { message: string }[] }).__sent);

const FIELD = '.fy-composer-input-layer textarea, .fy-composer-input-layer [contenteditable="true"]';

const geometry = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
    const send = box('[data-composer-send]');
    const form = box('form.fy-composer');
    const field = box('.fy-composer-input-layer');
    const row = box('.fy-composer-row');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      send: { top: send?.top ?? NaN, bottom: send?.bottom ?? NaN, left: send?.left ?? NaN, right: send?.right ?? NaN },
      formHeight: form?.height ?? NaN,
      fieldWidth: field?.width ?? NaN,
      rowWidth: row?.width ?? NaN,
    };
  });

for (const mode of ['light', 'dark'] as const)
  describe(`the ferret page's composer (${mode})`, () => {
    for (const size of WINDOWS)
      it(`at ${size.name}: Send is inside the window and sends${size.phone ? '' : ', and so does Enter'}`, async () => {
        const { tab, close } = await open(size, mode);
        try {
          const field = tab.locator(FIELD).first();
          await field.click();
          await tab.keyboard.type('hello from the app');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}.png`) });

          const seen = await geometry(tab);
          expect(seen.send.top, 'Send starts inside the window').toBeGreaterThanOrEqual(0);
          expect(seen.send.bottom, 'Send ends inside the window (not painted below the strip)').toBeLessThanOrEqual(
            seen.window.height,
          );
          expect(seen.send.left).toBeGreaterThanOrEqual(0);
          expect(seen.send.right).toBeLessThanOrEqual(seen.window.width);
          expect(
            seen.formHeight,
            'the composer is a compact block, never a column taller than the window',
          ).toBeLessThan(seen.window.height / 3);
          expect(seen.fieldWidth, 'the box keeps most of the row').toBeGreaterThanOrEqual(seen.rowWidth * 0.4);

          if (size.phone) {
            await tab.click('[data-composer-send]');
          } else {
            await tab.keyboard.press('Enter');
          }
          await tab.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length >= 1);
          expect((await sentOf(tab)).map(entry => entry.message)).toEqual(['hello from the app']);

          if (!size.phone) {
            // And the button takes a real click too (the sweep's click timed out outside the strip).
            await field.click();
            await tab.keyboard.type('second');
            await tab.click('[data-composer-send]');
            await tab.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length >= 2);
            expect((await sentOf(tab)).map(entry => entry.message)).toEqual(['hello from the app', 'second']);
          }
        } finally {
          await close();
        }
      });
  });
