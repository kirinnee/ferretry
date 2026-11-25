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
type Viewport = { readonly name: string; readonly width: number; readonly height: number; readonly phone: boolean };
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
              expect(
                composer.bottom,
                'the composer surface reaches the screen edge: the chat column pays the inset inside it',
              ).toBeCloseTo(seen.window, 0);
              expect(composer.paddingBottom, 'the composer pays the inset once').toBe(Math.max(8, inset));
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

// ─── the follow-up: the phone's Bottom bar setting, and the wide layout with an inset (a tablet) ─────────────────────────────

const edges = async (tab: Page) =>
  await tab.evaluate(() => {
    const edge = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      return {
        bottom: element.getBoundingClientRect().bottom,
        paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
      };
    };
    return {
      window: window.innerHeight,
      frame: edge('.fy-frame'),
      nav: edge('.fy-nav--bottom'),
      drawer: edge('.fy-drawer:not(.fy-drawer--overlay)'),
      main: edge('.fy-main'),
      side: edge('.fy-ferret-side:not([style*="display"]), [data-side-rail]'),
      composer: edge('[data-composer]'),
    };
  });

describe('the phone with the Bottom bar setting pays the home indicator once, in the bar', () => {
  for (const inset of INSETS) {
    for (const mode of MODES) {
      it(`390, bottom bar, inset ${inset}, ${mode}: the bar reaches the edge and pays max(8, inset); the composer above it pays only its own padding`, async () => {
        const { tab, close } = await open(
          VIEWPORTS[0],
          inset,
          mode,
          '/d/ws/ferrets/zoe?safe=1&relay=0&phonenav=bottom',
          '[data-composer]',
        );
        try {
          const seen = await edges(tab);
          if (seen.nav === null || seen.composer === null) throw new Error('the bar or the composer is not on screen');
          expect(seen.nav.bottom, 'the bar reaches the screen edge').toBeCloseTo(seen.window, 0);
          expect(seen.nav.paddingBottom, 'the bar pays max(its own 8px, the inset) once').toBe(Math.max(8, inset));
          expect(seen.frame?.paddingBottom, 'the shell pays nothing').toBe(0);
          const bar = await tab.evaluate(() => {
            const composer = document.querySelector('[data-composer]') as HTMLElement;
            const nav = document.querySelector('.fy-nav--bottom') as HTMLElement;
            return { gap: nav.getBoundingClientRect().top - composer.getBoundingClientRect().bottom };
          });
          expect(bar.gap, 'the composer ends where the bar begins, no second inset between them').toBeCloseTo(0, 0);
          expect(seen.composer.paddingBottom, 'the composer pays its own padding only (never the inset again)').toBe(8);
          await shot(tab, `F1-390-bottom-bar-${mode}-inset-${inset}`);
        } finally {
          await close();
        }
      });

      it(`390, bottom bar, inset ${inset}, ${mode}: a screen that ends in content has the bar at the edge and nothing paid twice`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], inset, mode, '/d/ws/agenda?relay=0&phonenav=bottom', 'main');
        try {
          const seen = await edges(tab);
          expect(seen.nav?.bottom, 'the bar reaches the screen edge').toBeCloseTo(seen.window, 0);
          expect(seen.nav?.paddingBottom, 'the bar pays max(8, inset)').toBe(Math.max(8, inset));
          expect(seen.frame?.paddingBottom, 'the shell pays nothing').toBe(0);
          await shot(tab, `F1-390-bottom-bar-${mode}-inset-${inset}-content`);
        } finally {
          await close();
        }
      });
    }
  }
});

describe('the wide layout with an inset (a tablet) lets every column reach the edge and pays the inset once inside', () => {
  const WIDE_VIEWPORTS = [
    { name: '820', width: 820, height: 1_180, phone: false },
    { name: '1440', width: 1_440, height: 900, phone: false },
  ] as const;
  for (const viewport of WIDE_VIEWPORTS) {
    for (const inset of INSETS) {
      for (const mode of MODES) {
        it(`${viewport.name}, inset ${inset}, ${mode}: the sidebar and the page column run to the screen edge, each padding its content by the inset`, async () => {
          const { tab, close } = await open(viewport, inset, mode, '/d/ws/agenda?relay=0', 'main');
          try {
            const seen = await edges(tab);
            if (seen.drawer === null || seen.main === null) throw new Error('the columns are not on screen');
            expect(seen.frame?.paddingBottom, 'the shell pays nothing: no band of page ground under the columns').toBe(
              0,
            );
            expect(seen.drawer.bottom, 'the sidebar surface reaches the screen edge').toBeCloseTo(seen.window, 0);
            expect(seen.main.bottom, 'the page column reaches the screen edge').toBeCloseTo(seen.window, 0);
            expect(seen.drawer.paddingBottom, 'the sidebar pays the inset once').toBe(Math.max(8, inset));
            expect(seen.main.paddingBottom, 'the page column pays the inset once').toBe(Math.max(16, inset));
            await shot(tab, `F2-${viewport.name}-${mode}-inset-${inset}`);
          } finally {
            await close();
          }
        });

        it(`${viewport.name}, inset ${inset}, ${mode}: the chat's composer and side pane run to the screen edge, the inset paid once between them`, async () => {
          const { tab, close } = await open(
            viewport,
            inset,
            mode,
            '/d/ws/ferrets/zoe?safe=1&relay=0',
            '[data-composer]',
          );
          try {
            const seen = await edges(tab);
            if (seen.composer === null) throw new Error('the composer is not on screen');
            expect(seen.frame?.paddingBottom, 'the shell pays nothing').toBe(0);
            expect(seen.main?.bottom, 'the chat column reaches the screen edge').toBeCloseTo(seen.window, 0);
            expect(seen.main?.paddingBottom, 'the chat page column pays nothing itself: what it holds pays').toBe(0);
            if (seen.side === null) throw new Error('the side pane is not on screen');
            expect(seen.side.bottom, 'the slim side rail reaches the screen edge').toBeCloseTo(seen.window, 0);
            expect(seen.side.paddingBottom, 'the slim rail pays max(its own 8px, the inset) once').toBe(
              Math.max(8, inset),
            );
            if (viewport.width === 1_440) {
              // Beside each other: the composer's surface runs to the edge and it pays max(own 8px, inset).
              expect(seen.composer.bottom, 'the composer surface reaches the screen edge').toBeCloseTo(seen.window, 0);
              expect(seen.composer.paddingBottom, 'the composer pays the inset once').toBe(Math.max(8, inset));
            } else {
              // Stacked (the pane under the chat): the pane is the last row and pays it, so the composer pays only its own padding.
              expect(seen.composer.paddingBottom, 'the composer above the pane pays only its own padding').toBe(8);
            }
            await shot(tab, `F2-${viewport.name}-${mode}-inset-${inset}-chat`);
            // Open, the pane is the column that meets the edge: it pays the inset once, the rail is gone.
            await tab.click('[data-side-toggle]');
            await tab.waitForSelector('[data-ferret-side] [data-side-panel]', { state: 'attached' });
            const open = await edges(tab);
            expect(open.side?.bottom, 'the open side pane reaches the screen edge').toBeCloseTo(open.window, 0);
            expect(open.side?.paddingBottom, 'the open side pane pays the inset once').toBe(inset);
            expect(
              open.composer?.paddingBottom,
              'the composer pays its own padding, or the inset when it ends the row',
            ).toBe(viewport.width === 1_440 ? Math.max(8, inset) : 8);
            await shot(tab, `F2-${viewport.name}-${mode}-inset-${inset}-chat-open`);
          } finally {
            await close();
          }
        });
      }
    }
  }
});
