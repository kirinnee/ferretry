/**
 * SETTINGS AT A MID-WIDTH WINDOW (768 and 1024) in a real browser over fake data: the drawer, the settings list and the panel
 * cannot all fit side by side (at 768 the panel was ~212px between two sidebars), so the list stands above the panel and the
 * panel is at least 480px wide on EVERY tab, with no sideways scroll, and the list is still reachable (by pointer, by keyboard,
 * and by scrolling it).
 *
 * Set `FY_SETTINGS_NARROW_SHOTS_DIR` to keep `<viewport>-<scheme>-<tab>.png` (768 light and dark, three tabs).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTINGS_NARROW_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-narrow-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the settings narrow scene did not build (${code}):\n${stderr}\n${stdout}`);
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
const MIN_PANEL = 480;
const SIZES = [
  { name: '768', width: 768, height: 1_024 },
  { name: '1024', width: 1_024, height: 768 },
] as const;
const SHOT_TABS = ['logins', 'agenda', 'connections'];

const open = async (width: number, height: number, scheme: 'light' | 'dark', path: string) => {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}${path}?theme=studio-${scheme}`);
  await tab.waitForSelector('.fy-settings-page');
  return { tab, close: async () => await context.close() };
};

const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const width = (selector: string): number =>
      document.querySelector(selector)?.getBoundingClientRect().width ?? Number.NaN;
    const scrolls = (node: Element | null): boolean => node !== null && node.scrollWidth > node.clientWidth + 1;
    return {
      panel: width('.fy-settings-page'),
      drawer: width('.fy-drawer'),
      nav: width('.fy-settings-nav'),
      pageSideways: scrolls(document.documentElement),
      mainSideways: scrolls(document.querySelector('.fy-main')),
      scrollSideways: scrolls(document.querySelector('.fy-settings-body')),
      handle: (() => {
        const strip = document.querySelector('[data-resize-handle="settings-nav"]');
        return strip === null || getComputedStyle(strip).display === 'none' ? 'none' : 'drawn';
      })(),
    };
  });

describe('Settings at a mid-width window', () => {
  for (const size of SIZES) {
    it(`${size.name}: the panel is at least ${MIN_PANEL}px wide on every tab, nothing scrolls sideways, the list is reachable`, async () => {
      const { tab, close } = await open(size.width, size.height, 'light', '/d/ws/settings');
      try {
        const hrefs = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLAnchorElement>('.fy-settings-nav a.fy-tab:not(.fy-settings-device)')].map(
            link => link.getAttribute('href'),
          ),
        );
        expect(hrefs.length).toBeGreaterThan(10);
        const failures: string[] = [];
        for (const href of hrefs) {
          // The way a person goes: the list's own link (its group opened first when it is shut).
          const link = tab.locator(`.fy-settings-nav a.fy-tab:not(.fy-settings-device)[href="${href}"]`);
          if (!(await link.isVisible())) {
            await tab.locator(`details.fy-tab-group:has(a[href="${href}"]) > summary`).click();
          }
          await link.scrollIntoViewIfNeeded();
          await link.click();
          await tab.waitForSelector('.fy-settings-page');
          const seen = await measure(tab);
          if (!(seen.panel >= MIN_PANEL)) failures.push(`${href}: panel ${seen.panel}px`);
          if (seen.pageSideways || seen.mainSideways || seen.scrollSideways) failures.push(`${href}: scrolls sideways`);
          expect(seen.handle).toBe('none');
        }
        expect(failures).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${size.name}: the list is above the panel, scrolls inside itself and a keyboard reaches its links`, async () => {
      const { tab, close } = await open(size.width, size.height, 'light', '/d/ws/settings/logins');
      try {
        const layout = await tab.evaluate(() => {
          const nav = document.querySelector('.fy-settings-nav') as HTMLElement;
          const page = document.querySelector('.fy-settings-page') as HTMLElement;
          return {
            above: nav.getBoundingClientRect().bottom <= page.getBoundingClientRect().top + 1,
            overflowY: getComputedStyle(document.querySelector('.fy-settings-block') as HTMLElement).overflowY,
            height: nav.getBoundingClientRect().height,
            cue: getComputedStyle(document.querySelector('.fy-settings-block') as HTMLElement).backgroundImage.includes(
              'linear-gradient',
            ),
          };
        });
        expect(layout.above).toBe(true);
        expect(layout.overflowY).toBe('auto'); // each block scrolls on its own
        expect(layout.height).toBeLessThanOrEqual(260);
        expect(layout.cue).toBe(true);
        // The current tab is in view inside the list, not hidden below its fold.
        const current = await tab.locator('.fy-settings-nav .fy-tab--active').boundingBox();
        const listBox = await tab.locator('.fy-settings-nav .fy-settings-block:has(.fy-tab--active)').boundingBox();
        expect(
          current !== null &&
            listBox !== null &&
            current.y >= listBox.y - 1 &&
            current.y + current.height <= listBox.y + listBox.height + 1,
        ).toBe(true);
        // Keyboard: Tab from the top of the page lands on the list's links before the panel's own controls.
        await tab.locator('.fy-settings-device').focus();
        await tab.keyboard.press('Tab');
        const focused = await tab.evaluate(() => document.activeElement?.closest('.fy-settings-nav') !== null);
        expect(focused).toBe(true);
        // Everything in the list can be brought into view inside it (the last link included).
        const last = tab.locator('.fy-settings-nav a.fy-tab:not(.fy-settings-device)').last();
        const inside = await tab
          .locator('.fy-settings-nav details.fy-tab-group')
          .last()
          .evaluate(node => {
            (node as HTMLDetailsElement).open = true;
            return true;
          });
        expect(inside).toBe(true);
        await last.scrollIntoViewIfNeeded();
        const box = await last.boundingBox();
        const navBox = await tab.locator('.fy-settings-nav .fy-settings-block:last-child').boundingBox();
        expect(
          box !== null &&
            navBox !== null &&
            box.y >= navBox.y - 1 &&
            box.y + box.height <= navBox.y + navBox.height + 1,
        ).toBe(true);
      } finally {
        await close();
      }
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    it(`768 ${scheme}: shots of three tabs`, async () => {
      for (const name of SHOT_TABS) {
        const { tab, close } = await open(768, 1_024, scheme, `/d/ws/settings/${name}`);
        try {
          const seen = await measure(tab);
          expect(seen.panel).toBeGreaterThanOrEqual(MIN_PANEL);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `768-${scheme}-${name}.png`) });
        } finally {
          await close();
        }
      }
    });
  }
});
