/**
 * E54: THE HOME INDICATOR IS PAID ONCE, in a real browser over fake data (`fixtures/frame-scene.tsx`): the real shell, the
 * real stylesheet, a fake composer that carries what the real one carries (`fy-chat-input` + `data-safe-bottom`).
 *
 * The owner's report: on a phone with a home indicator the composer sat 34px too high — a blank band under it — because the
 * shell (`.fy-frame`) AND the composer bar both paid `--safe-bottom`. The stylesheet's rule that makes the shell pay nothing
 * while a bar owns the inset was written for a class (`.kt-shell`) the shell no longer has.
 *
 * The inset is the browser's own: Chromium's `Emulation.setSafeAreaInsetsOverride` makes `env(safe-area-inset-bottom)` read
 * the number, exactly as a phone with a home indicator reports it — so every rule that reads `env()` or `--safe-bottom` sees it.
 * Each case runs at inset 0 (no indicator) AND 34 (an iPhone 15 Pro).
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<name>.png` shots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';

let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-bottom-inset-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
type Viewport = (typeof VIEWPORTS)[number];
const INSETS = [0, 34] as const;
const MODES = ['light', 'dark'] as const;

const open = async (viewport: Viewport, inset: number, mode: (typeof MODES)[number], path: string, ready: string) => {
  const browser = await sharedChromium();
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  // The platform's own report of the home indicator: `env(safe-area-inset-bottom)` reads `inset` px.
  const cdp = await context.newCDPSession(tab);
  await cdp.send(
    'Emulation.setSafeAreaInsetsOverride' as never,
    { insets: { top: 0, left: 0, right: 0, bottom: inset } } as never,
  );
  await tab.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=studio-${mode}`);
  await tab.waitForSelector(ready);
  return { tab, close: async () => await context.close() };
};

const reading = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height, paddingBottom: parseFloat(getComputedStyle(element).paddingBottom) };
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.append(probe);
    const env = parseFloat(getComputedStyle(probe).paddingBottom);
    probe.remove();
    return {
      env,
      window: window.innerHeight,
      frame: box('.fy-frame'),
      composer: box('[data-composer]'),
      field: box('[data-composer-field]'),
      main: box('[data-shell-main]'),
    };
  });

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('the home indicator is paid once', () => {
  for (const viewport of VIEWPORTS) {
    for (const inset of INSETS) {
      for (const mode of MODES) {
        it(`${viewport.name}, inset ${inset}, ${mode}: the composer's surface runs to the screen edge and its field sits one inset above it`, async () => {
          const { tab, close } = await open(
            viewport,
            inset,
            mode,
            '/d/ws/ferrets/zoe?safe=1&relay=0',
            '[data-composer]',
          );
          try {
            const seen = await reading(tab);
            expect(seen.env, 'the emulated platform inset').toBe(inset);
            const composer = seen.composer;
            const field = seen.field;
            if (composer === null || field === null) throw new Error('the composer is not on screen');
            if (viewport.phone) {
              // The bar the screen ends in owns the inset: its surface reaches the edge, it pays max(own 8px, inset), the shell pays nothing.
              expect(composer.bottom, 'the surface reaches the screen edge').toBeCloseTo(seen.window, 0);
              expect(composer.paddingBottom, 'the bar pays the inset once').toBe(Math.max(8, inset));
              expect(seen.frame?.paddingBottom, 'the shell pays nothing under a bar that owns it').toBe(0);
              expect(
                seen.window - field.bottom,
                'the field sits max(8, inset) + its own 8px margin above the edge',
              ).toBeCloseTo(Math.max(8, inset) + 8, 0);
            } else {
              // Wide: the columns meet the bottom edge side by side, and the inset is paid once for all of them.
              expect(seen.window - composer.bottom, 'the inset is paid once under the composer').toBeCloseTo(inset, 0);
            }
            await shot(tab, `E54-${viewport.name}-${mode}-inset-${inset}`);
          } finally {
            await close();
          }
        });
      }
    }
  }
});

describe('every other surface that meets the bottom edge pays the home indicator once', () => {
  for (const inset of INSETS) {
    for (const mode of MODES) {
      it(`390, inset ${inset}, ${mode}: a screen that ends in content stops one inset above the edge (the shell pays it)`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], inset, mode, '/d/ws/agenda?relay=0', 'main');
        try {
          const seen = await tab.evaluate(() => ({
            window: window.innerHeight,
            main: document.querySelector('main')?.getBoundingClientRect().bottom ?? -1,
          }));
          expect(seen.main, 'the page column ends one inset above the screen edge').toBeCloseTo(seen.window - inset, 0);
          await shot(tab, `E54-390-${mode}-inset-${inset}-content`);
        } finally {
          await close();
        }
      });

      it(`390, inset ${inset}, ${mode}: the open drawer reaches the edge and its dock sits one inset (plus 8px) above it`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], inset, mode, '/d/ws/agenda?relay=0', 'main');
        try {
          await tab.click('button[aria-label="Menu"]');
          await tab.waitForSelector('.fy-drawer--overlay');
          const seen = await tab.evaluate(() => {
            const drawer = document.querySelector('.fy-drawer--overlay') as HTMLElement;
            const dock = drawer.querySelector('.fy-nav--dock') as HTMLElement;
            return {
              window: window.innerHeight,
              drawer: drawer.getBoundingClientRect().bottom,
              dock: dock.getBoundingClientRect().bottom,
            };
          });
          expect(seen.drawer, 'the drawer surface reaches the screen edge').toBeCloseTo(seen.window, 0);
          expect(seen.drawer - seen.dock, 'its foot is clear of the indicator, once').toBeCloseTo(inset + 8, 0);
          await shot(tab, `E54-390-${mode}-inset-${inset}-drawer`);
        } finally {
          await close();
        }
      });
    }
  }
});
