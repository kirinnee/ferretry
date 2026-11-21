/**
 * THE USAGE LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the owner's
 * line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search". Two real controls are driven end to end:
 *
 *   Insights query › Metric          open -> type -> pick: the query text is rewritten exactly as the helper always did
 *   Insights › Days in (time zone)   open -> type -> pick: the zone the page learns, from every zone the browser lists
 *
 * at 1280 (a popover under the box) and at 390 with touch (a CENTRED dialog with a focused search field), light and
 * dark. Both scenes hold 0 `select` elements. Set `FY_USAGE_SELECT_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_USAGE_SELECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-usage-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Usage select scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
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
const THEMES = ['light', 'dark'] as const;

const openScene = async (
  scene: 'query' | 'zone',
  viewport: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: theme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?scene=${scene}&theme=studio-${theme}`);
  return { context, tab };
};

/** The open list: a popover listbox (mouse) or a centred dialog (phone), and the geometry the owner's line is about. */
const listing = async (tab: Page) =>
  await tab.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.fy-dialog [role="dialog"]');
    const popover = document.querySelector<HTMLElement>('[data-select-popover]');
    const box = (dialog ?? popover)?.getBoundingClientRect();
    const input = document.querySelector<HTMLInputElement>('.fy-sb__input');
    return {
      asDialog: dialog !== null,
      asPopover: popover !== null,
      centreDx: box === undefined ? null : Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
      centreDy: box === undefined ? null : Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
      options: [...document.querySelectorAll('[role="option"]')].map(
        option => option.querySelector('[data-label]')?.textContent ?? '',
      ),
      hasSearch: input !== null,
      searchFocused: input !== null && document.activeElement === input,
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

const shoot = async (tab: Page, viewport: string, theme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.waitForTimeout(450);
  await tab.screenshot({ animations: 'disabled', path: join(shotsDir, `${viewport}-${theme}-${name}.png`) });
};

const closed = async (tab: Page): Promise<unknown> =>
  await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);

describe('Usage picks from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES) {
      it(`Query helpers: open Metric, type to narrow, pick, the query text is rewritten (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('query', viewport, theme);
        try {
          const box = '[role="combobox"][aria-label="Metric"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.textContent(box)).toContain('Equivalent API cost');
          expect(await tab.getAttribute(box, 'id'), 'the visible label points at the box').not.toBeNull();
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          console.info(
            `MEASURED metric ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog} search=${open.hasSearch}`,
          );
          expect(open.options[0], 'the first choice is every measure').toBe('Every measure');
          expect(open.options.length, 'a long list').toBeGreaterThan(7);
          expect(open.hasSearch, 'a long list has a search field').toBe(true);
          expect(open.searchFocused, 'the search field has the focus').toBe(true);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover, 'a popover under the box on a desktop').toBe(true);
          }
          await shoot(tab, viewport.name, theme, 'metric-open');
          await tab.keyboard.type('turns');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length >= 1);
          const narrowed = (await listing(tab)).options;
          expect(narrowed.length, 'typing narrowed the list').toBeLessThan(open.options.length);
          await shoot(tab, viewport.name, theme, 'metric-filtered');
          await tab.getByRole('option', { name: 'Turns', exact: true }).click();
          await closed(tab);
          expect(await tab.textContent('[data-query]'), 'the one write: the query text').toBe(
            'sum(turns) by (model) [7d]',
          );
          expect(await tab.textContent(box)).toContain('Turns');
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
        } finally {
          await context.close();
        }
      });

      it(`Days in: open the time zones, type to narrow, pick (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('zone', viewport, theme);
        try {
          const box = '[role="combobox"][aria-label="Days in"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.textContent(box)).toContain('This device');
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          console.info(
            `MEASURED zone ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog} search=${open.hasSearch}`,
          );
          expect(open.options.length, 'every zone the browser lists').toBeGreaterThan(100);
          expect(open.hasSearch && open.searchFocused, 'search, focused').toBe(true);
          if (viewport.phone) {
            expect(open.asDialog).toBe(true);
            expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover).toBe(true);
          }
          await tab.keyboard.type('los_angeles');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
          expect((await listing(tab)).options).toEqual(['America/Los_Angeles']);
          await shoot(tab, viewport.name, theme, 'zone-filtered');
          await tab.keyboard.press('Enter');
          await closed(tab);
          expect(await tab.textContent('[data-chosen]')).toBe('America/Los_Angeles');
          expect(await tab.textContent(box)).toContain('America/Los_Angeles');
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
        } finally {
          await context.close();
        }
      });
    }
});
