/**
 * THE RUNTIME PICKER IS ONE COMPACT CONTROL IN THE COMPOSER'S ROW, in a real browser (ferret-page-send, items 2 and 4).
 *
 * The scene (`fixtures/runtime-picker-scene.tsx`) is the REAL picker panel in the composer's own row classes and the chat
 * page's column, over a fake daemon. It used to draw the model list and the reasoning list open IN the row: a column
 * taller than the window beside a one-word text box, Send below the fold, and a red error box on every composer when the
 * daemon had no runtime discovery. Now, at the sweep's two windows and a phone, light and dark:
 *
 *  - at rest the row is one compact line: the chip, the box keeping most of the row, Send inside the window; no list and
 *    no error, and no model catalog was asked for;
 *  - a tap opens a popover that lies entirely inside the window, above the chip, with both lists;
 *  - with no runtime discovery the popover says so once, quietly (no red alert).
 *
 * Set `FY_RUNTIME_PICKER_SHOTS_DIR` to keep `<window>-<mode>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RUNTIME_PICKER_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-runtime-picker-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/runtime-picker-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the runtime picker scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js] = [await readFile(built.css, 'utf8'), await readFile(built.js, 'utf8')];
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

const open = async (size: (typeof WINDOWS)[number], mode: 'light' | 'dark', extra = '') => {
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
  await tab.goto(`${origin}/?theme=studio-${mode}${size.phone ? '&compact=1' : ''}${extra}`);
  await tab.waitForSelector('[data-runtime-chip]');
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const rest = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
    const send = box('[data-composer-send]');
    const form = box('form.fy-composer');
    const field = box('.fy-composer-input-layer');
    const row = box('.fy-composer-row');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      sendBottom: send?.bottom ?? NaN,
      sendRight: send?.right ?? NaN,
      formHeight: form?.height ?? NaN,
      fieldWidth: field?.width ?? NaN,
      rowWidth: row?.width ?? NaN,
      chipRight: box('[data-runtime-chip]')?.right ?? NaN,
      fieldLeft: box('.fy-composer-input-layer')?.left ?? NaN,
      menus: document.querySelectorAll('[role="menu"]').length,
      alerts: document.querySelectorAll('[role="alert"]').length,
      asked: (window as unknown as { __asked: string[] }).__asked.slice(),
    };
  });

for (const mode of ['light', 'dark'] as const)
  describe(`the runtime picker in the composer row (${mode})`, () => {
    for (const size of WINDOWS) {
      it(`at ${size.name}: one compact line at rest — the box keeps the row, Send is inside, nothing is asked or said`, async () => {
        const { tab, close } = await open(size, mode, '&discovery=0');
        try {
          await tab.waitForTimeout(300);
          await shot(tab, `${size.name}-${mode}-rest`);
          const seen = await rest(tab);
          expect(seen.formHeight, 'one compact block, not a column taller than the window').toBeLessThan(120);
          expect(seen.sendBottom, 'Send is inside the window').toBeLessThanOrEqual(seen.window.height);
          expect(seen.sendRight, 'Send is inside the window sideways').toBeLessThanOrEqual(seen.window.width);
          expect(seen.fieldWidth, 'the box keeps most of the row').toBeGreaterThanOrEqual(seen.rowWidth * 0.4);
          expect(seen.chipRight, 'the chip does not overlap the box').toBeLessThanOrEqual(seen.fieldLeft);
          expect(seen.menus, 'no list drawn in the row').toBe(0);
          expect(seen.alerts, 'no error on a composer nobody opened the picker on').toBe(0);
          expect(seen.asked, 'no model catalog asked for').not.toContain('GET /v1/ferrets/:id/runtime-models');
        } finally {
          await close();
        }
      });

      it(`at ${size.name}: a tap opens a popover wholly inside the window, above the chip, with both lists`, async () => {
        const { tab, close } = await open(size, mode);
        try {
          await tab.click('[data-runtime-chip]');
          await tab.waitForSelector('[data-runtime-popover] [role="menu"]');
          await tab.waitForSelector('[data-runtime-popover] [role="menuitemradio"]');
          await shot(tab, `${size.name}-${mode}-open`);
          const box = await tab.evaluate(() => {
            const popover = document.querySelector('[data-runtime-popover]')?.getBoundingClientRect();
            const chip = document.querySelector('[data-runtime-chip]')?.getBoundingClientRect();
            return {
              window: { width: window.innerWidth, height: window.innerHeight },
              popover: {
                top: popover?.top ?? NaN,
                bottom: popover?.bottom ?? NaN,
                left: popover?.left ?? NaN,
                right: popover?.right ?? NaN,
              },
              chipTop: chip?.top ?? NaN,
              menus: document.querySelectorAll('[data-runtime-popover] [role="menu"]').length,
            };
          });
          expect(box.popover.top, 'inside the window, top').toBeGreaterThanOrEqual(0);
          expect(box.popover.left, 'inside the window, left').toBeGreaterThanOrEqual(0);
          expect(box.popover.right, 'inside the window, right').toBeLessThanOrEqual(box.window.width);
          expect(box.popover.bottom, 'above the chip').toBeLessThanOrEqual(box.chipTop);
          expect(box.menus, 'the model list and the reasoning list').toBeGreaterThanOrEqual(2);
          await tab.keyboard.press('Escape');
          await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
        } finally {
          await close();
        }
      });
    }

    it('with no runtime discovery the popover says so once, quietly — no red alert', async () => {
      const { tab, close } = await open(WINDOWS[0], mode, '&discovery=0');
      try {
        await tab.click('[data-runtime-chip]');
        await tab.waitForSelector('[data-model-choices-unavailable]');
        await shot(tab, `1280x713-${mode}-no-discovery`);
        const said = await tab.evaluate(() => ({
          count: (document.body.textContent?.match(/not connected to Ferrets yet/g) ?? []).length,
          alerts: document.querySelectorAll('[role="alert"]').length,
        }));
        expect(said.count).toBe(1);
        expect(said.alerts).toBe(0);
      } finally {
        await close();
      }
    });
  });
