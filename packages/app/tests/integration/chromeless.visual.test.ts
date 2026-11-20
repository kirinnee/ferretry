/**
 * CHROME-LESS SCREENS (r10 O2), in a real browser, on a phone and a desktop, in light and dark, over fake data
 * (`fixtures/chromeless-scene.tsx`): the `flow` screen has no drawer, nav, side column or title bar and the page uses the
 * whole width; the `plain` screen next to it keeps them.
 *
 * Cmd/Ctrl+B (e-cmdb) on the `flow` screen draws no drawer and never writes the remembered rail setting; on `plain` it toggles.
 *
 * Set `FY_CHROMELESS_SHOTS_DIR` to keep `<viewport>-<scheme>-<view>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CHROMELESS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chromeless-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/chromeless-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '768', width: 768, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark', view: string, path: string) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab: Page = await context.newPage();
  await tab.goto(`${origin}${path}?theme=studio-${scheme}&view=${view}`);
  await tab.waitForFunction(() => document.body.innerText.includes('Set up this device'), undefined, {
    timeout: 15_000,
  });
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { tab, close: async () => await context.close() };
};

const CHROME = '.fy-drawer, [data-slot="drawer"], .fy-nav, .fy-side, [data-slot="phone-title"], [data-drawer-toggle]';

describe('chrome-less screens', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`flow: the page stands alone and uses the width (${viewport.name}, ${scheme})`, async () => {
        const { tab, close } = await open(viewport, scheme, 'flow', '/flow');
        try {
          expect(await tab.locator(CHROME).count(), 'no chrome').toBe(0);
          // e-cmdb: the drawer shortcut does nothing here and never writes the remembered rail setting.
          await tab.keyboard.press('Control+b');
          await tab.keyboard.press('Meta+b');
          await tab.evaluate(
            () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
          );
          expect(await tab.locator(`${CHROME}, .fy-drawer-scrim`).count(), 'no drawer after Ctrl/Cmd+B').toBe(0);
          expect(
            await tab.evaluate(() => Object.keys(localStorage).filter(key => key.includes('drawer'))),
            'the remembered rail setting was not written',
          ).toEqual([]);
          const box = await tab.locator('.fy-main').boundingBox();
          expect(box?.x, 'the page starts at the left edge').toBe(0);
          expect(Math.round(box?.width ?? 0), 'the page uses the full width').toBe(viewport.width);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-flow.png`) });
        } finally {
          await close();
        }
      });

      it(`plain: the same page keeps the shell around it (${viewport.name}, ${scheme})`, async () => {
        const { tab, close } = await open(viewport, scheme, 'plain', '/plain');
        try {
          expect(await tab.locator(CHROME).count(), 'chrome is there').toBeGreaterThan(0);
          if (!viewport.phone) {
            const rail = async () => await tab.locator('.fy-drawer--rail').count();
            const before = await rail();
            await tab.keyboard.press('Control+b');
            expect(await rail(), 'Ctrl+B still toggles the rail on an ordinary screen').toBe(before === 0 ? 1 : 0);
          }
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-plain.png`) });
        } finally {
          await close();
        }
      });
    }
});
