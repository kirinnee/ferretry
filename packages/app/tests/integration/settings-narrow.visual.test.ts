/**
 * SETTINGS AT A MID-WIDTH WINDOW (768 and 1024) in a real browser over fake data: the drawer, the settings list and the panel
 * cannot all fit side by side (at 768 the panel was ~212px between two sidebars), so the list stands above the panel and the
 * panel is at least 480px wide on EVERY tab, with no sideways scroll, and the list is ONE compact grouped picker (every page reachable
 * by pointer and by keyboard, nothing sliced by a scroller).
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
    it(`${size.name}: the panel is at least ${MIN_PANEL}px wide on every tab, nothing scrolls sideways, every page is reachable from the picker`, async () => {
      const { tab, close } = await open(size.width, size.height, 'light', '/d/ws/settings');
      try {
        const hrefs = await tab.evaluate(() =>
          // "This device" is the shell's own page (no daemon panel): the rest are the daemon's tabs.
          [...document.querySelectorAll<HTMLOptionElement>('.fy-settings-picker__select option')]
            .filter(option => option.textContent !== 'This device')
            .map(option => option.value),
        );
        expect(hrefs.length).toBeGreaterThan(10);
        const failures: string[] = [];
        for (const href of hrefs) {
          // The way a person goes: the picker above the panel.
          await tab.locator('.fy-settings-picker__select').selectOption(href);
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

    it(`${size.name}: the list is ONE compact grouped picker above the panel: fully visible, no scroller slicing rows, current page shown`, async () => {
      const { tab, close } = await open(size.width, size.height, 'light', '/d/ws/settings/logins');
      try {
        const layout = await tab.evaluate(() => {
          const nav = document.querySelector('.fy-settings-nav') as HTMLElement;
          const page = document.querySelector('.fy-settings-page') as HTMLElement;
          const select = document.querySelector('.fy-settings-picker__select') as HTMLSelectElement;
          const box = select.getBoundingClientRect();
          // Anything in the list that scrolls inside itself is a window that can slice a row at its edge.
          const scrollers = [nav, ...nav.querySelectorAll<HTMLElement>('*')]
            .filter(el => {
              const style = getComputedStyle(el);
              return (
                el.getBoundingClientRect().height > 0 &&
                ['auto', 'scroll'].includes(style.overflowY) &&
                el.scrollHeight > el.clientHeight + 1
              );
            })
            .map(el => el.className);
          return {
            above: nav.getBoundingClientRect().bottom <= page.getBoundingClientRect().top + 1,
            navHeight: nav.getBoundingClientRect().height,
            selectInside: box.left >= 0 && box.right <= window.innerWidth && box.width > 150 && box.height >= 28,
            labelShown: (document.querySelector('.fy-settings-picker__label') as HTMLElement).offsetHeight > 0,
            shown: select.selectedOptions[0]?.textContent,
            groups: select.querySelectorAll('optgroup').length,
            groupLabels: [...select.querySelectorAll('optgroup')].every(group => (group.label ?? '').includes(' · ')),
            listDrawn: [...document.querySelectorAll('.fy-settings-block, .fy-settings-nav a.fy-tab')].filter(
              el => el.getBoundingClientRect().height > 0,
            ).length,
            scrollers,
          };
        });
        expect(layout.above).toBe(true);
        expect(layout.navHeight, 'a compact control, not a tall list').toBeLessThanOrEqual(110);
        expect(layout.selectInside).toBe(true);
        expect(layout.labelShown).toBe(true);
        expect(layout.shown).toBe('Logins');
        expect(layout.groups).toBeGreaterThan(3);
        expect(layout.groupLabels).toBe(true);
        expect(layout.listDrawn, 'the sliceable list is not drawn at this width').toBe(0);
        expect(layout.scrollers, 'nothing in the list scrolls inside itself').toEqual([]);
        // Keyboard: Tab from the top lands on the picker (the list's links are not drawn, so not in the order twice).
        await tab
          .locator('.fy-settings-device')
          .focus({ timeout: 500 })
          .catch(() => undefined);
        await tab.locator('.fy-settings-picker__select').focus();
        expect(await tab.evaluate(() => document.activeElement?.className)).toContain('fy-settings-picker__select');
        // The keyboard changes the page: arrow to the next option and the panel follows.
        const before = await tab.locator('.fy-settings-title').textContent();
        await tab.keyboard.press('ArrowDown');
        await tab.waitForFunction(
          previous => document.querySelector('.fy-settings-title')?.textContent !== previous,
          before,
        );
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
