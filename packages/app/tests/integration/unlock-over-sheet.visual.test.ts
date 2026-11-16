/**
 * THE PASSKEY PROMPT PAINTS OVER AN OPEN BODY-LEVEL SHEET, in a real browser, over fake data (`fixtures/unlock-over-sheet-scene.tsx`):
 * the shell's real `PasskeyMount` inside the real fixed `.fy-frame`, the app's real `BottomSheet` (the layer the Agenda options sheet uses),
 * and a stand-in for Access's prompt at Access's own `position: fixed; z-index: 70`.
 *
 * `.fy-frame` is `position: fixed`, so it is its own stacking context: a prompt drawn inside it is only z-70 LOCAL to the frame, and the
 * menus and sheets portal to `document.body` (z-40 / z-45), which then paint over the whole frame, prompt included. A background unlock
 * for the machine on screen raised while the options sheet was open could not be pressed. `PasskeyMount` draws its prompt at the document
 * root, so it clears the sheet, the menus and the command bar.
 *
 * The ceremony is a fake that does nothing; this test never creates, asks for or asserts a passkey.
 *
 * Set `FY_UNLOCK_LAYER_SHOTS_DIR` to keep `<viewport>-options-open-unlock-over.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_UNLOCK_LAYER_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-unlock-over-sheet-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/unlock-over-sheet-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the unlock-over-sheet scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const openWithSheet = async (viewport: (typeof VIEWPORTS)[number]) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-light`);
  await tab.locator('[data-options-toggle]').click();
  await tab.locator('[data-bottom-sheet]').waitFor({ state: 'visible' });
  await tab.waitForTimeout(300);
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const raise = async (tab: Page): Promise<void> => {
  await tab.evaluate(() => (window as unknown as { raiseUnlock: () => void }).raiseUnlock());
  await tab.locator('[data-step-up-confirm]').waitFor({ state: 'visible' });
};

describe('the passkey prompt over an open options sheet, inside the REAL fixed frame', () => {
  for (const viewport of VIEWPORTS) {
    it(`a background unlock raised while the sheet is open is the thing at its own button (${viewport.name})`, async () => {
      const { tab, close } = await openWithSheet(viewport);
      try {
        const frame = await tab.evaluate(
          () => getComputedStyle(document.querySelector('.fy-frame') as Element).position,
        );
        expect(frame, 'the fixture mounts the real, fixed frame').toBe('fixed');
        await raise(tab);
        await tab.waitForTimeout(200);
        const hit = await tab.evaluate(() => {
          const confirm = document.querySelector('[data-step-up-confirm]') as Element;
          const box = confirm.getBoundingClientRect();
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          const sheet = document.querySelector('[data-bottom-sheet]');
          return {
            button: at !== null && confirm.contains(at),
            inSheet: sheet?.contains(at) === true,
            what: at?.outerHTML.slice(0, 100) ?? 'nothing',
          };
        });
        await shot(tab, `${viewport.name}-options-open-unlock-over`);
        expect(hit.inSheet, `the sheet does not take the click (${hit.what})`).toBe(false);
        expect(hit.button, `the unlock button is what is at its own centre (${hit.what})`).toBe(true);
      } finally {
        await close();
      }
    });

    it(`the prompt takes focus, Escape dismisses it, and focus goes back to where it was (${viewport.name})`, async () => {
      const { tab, close } = await openWithSheet(viewport);
      try {
        const before = await tab.evaluate(() => {
          const active = document.activeElement;
          active?.setAttribute('data-test-opener', '');
          return active?.tagName ?? null;
        });
        await raise(tab);
        await tab.waitForTimeout(200);
        const inside = await tab.evaluate(
          () => document.querySelector('[data-step-up-dialog]')?.contains(document.activeElement) === true,
        );
        expect(inside, 'focus is inside the prompt').toBe(true);
        await tab.keyboard.press('Escape');
        await tab.locator('[data-step-up-dialog]').waitFor({ state: 'detached' });
        const back = await tab.evaluate(() => document.activeElement?.hasAttribute('data-test-opener') === true);
        expect(back, `focus returns to the element that had it (${before ?? 'none'})`).toBe(true);
      } finally {
        await close();
      }
    });
  }
});
