/**
 * THE BOARD'S LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the owner's
 * line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search". The board chose from a list in its filter bar
 * (and the phone's filter sheet) and on the lanes page (a lane's category, a gate option's outcome, where a deleted lane's
 * tasks go); each is asserted:
 *
 *   no `<select>` on the page; a click opens a listbox with a search field (1280) or a CENTRED dialog (390, touch, even over the
 *   filter bottom sheet); typing narrows the list and Enter picks; the pick is the same write a native select made (the filter
 *   state, the lane draft); a filter that is on keeps its tint.
 *
 * Set `FY_BOARD_SELECT_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_BOARD_SELECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-board-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the board select scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  scene: 'filters' | 'lanes',
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
    const list = document.querySelector<HTMLElement>('[role="listbox"]');
    return {
      asDialog: dialog !== null,
      asPopover: popover !== null,
      centreDx: box === undefined ? null : Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
      centreDy: box === undefined ? null : Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
      options: [...document.querySelectorAll('[role="option"]')].map(
        option => option.querySelector('[data-label]')?.textContent ?? '',
      ),
      hasSearch: document.querySelector('.fy-sb__input') !== null,
      listScrolls: list === null ? null : list.scrollHeight > list.clientHeight,
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

const createdPreset = async (tab: Page) =>
  await tab.evaluate(
    () => (window as unknown as { __filters: { created: { preset: string | null } } | null }).__filters?.created.preset,
  );

const filters = async (tab: Page) =>
  await tab.evaluate(() => (window as unknown as { __filters: Record<string, unknown> | null }).__filters);

describe('the board picks from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`the filters: type to narrow, Enter picks, the filter is set and tinted (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('filters', viewport, theme);
        try {
          if (viewport.phone) {
            await tab.click('.fy-board-filters__toggle');
            await tab.waitForSelector('.fy-board-filter-sheet [role="combobox"]');
          }
          await tab.waitForSelector('[data-filter="lane"] [role="combobox"]');
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          const lane = '[data-filter="lane"] [role="combobox"]';
          await tab.click(lane);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length, 'All lanes + 9 lanes').toBe(10);
          expect(open.hasSearch, 'a list this long has a search field').toBe(true);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone, over the filter sheet').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover).toBe(true);
          }
          if (shotsDir !== '') await tab.waitForTimeout(450);
          if (shotsDir !== '')
            await tab.screenshot({
              animations: 'disabled',
              path: join(shotsDir, `${viewport.name}-${theme}-filter-open.png`),
            });
          await tab.keyboard.type('rev');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
          expect((await listing(tab)).options).toEqual(['Review/CI']);
          await tab.keyboard.press('ArrowDown');
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          expect((await filters(tab))?.lane).toBe('Review/CI');
          expect(await tab.textContent(lane)).toContain('Review/CI');
          expect(await tab.getAttribute(lane, 'class')).toContain('is-set');
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
          if (shotsDir !== '') await tab.waitForTimeout(450);
          if (shotsDir !== '')
            await tab.screenshot({
              animations: 'disabled',
              path: join(shotsDir, `${viewport.name}-${theme}-filter-set.png`),
            });
        } finally {
          await context.close();
        }
      });

  for (const viewport of VIEWPORTS)
    it(`the date range preset and the state pick write what a native select did (${viewport.name})`, async () => {
      const { context, tab } = await openScene('filters', viewport, 'light');
      try {
        if (viewport.phone) await tab.click('.fy-board-filters__toggle');
        const created = '[data-filter="created-preset"] [role="combobox"]';
        await tab.waitForSelector(created);
        await tab.click(created);
        await tab.locator('[role="option"]', { hasText: 'Created: 7 days' }).click();
        expect(await createdPreset(tab)).toBe('7d');
        await tab.click('[data-filter="state"] [role="combobox"]');
        await tab.locator('[role="option"]', { hasText: 'State: closed' }).click();
        expect((await filters(tab))?.state).toBe('closed');
        // Custom… unfolds a from and a to, and clears the preset.
        await tab.click(created);
        await tab.locator('[role="option"]', { hasText: 'Created: custom…' }).click();
        await tab.waitForSelector('input[aria-label="Created from"]');
        expect(await createdPreset(tab)).toBeNull();
      } finally {
        await context.close();
      }
    });

  for (const viewport of VIEWPORTS)
    it(`the lanes page: category, a gate's outcome and where a deleted lane's tasks go (${viewport.name})`, async () => {
      const { context, tab } = await openScene('lanes', viewport, 'light');
      try {
        await tab.waitForSelector('[data-lane-page] [role="combobox"]');
        expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
        const category = '[role="combobox"][aria-label="Category of Implement"]';
        // A lane's category is a short word: its box is a fixed, modest width, not the whole row.
        const width = await tab.evaluate(
          query => document.querySelector(query)?.getBoundingClientRect().width ?? -1,
          category,
        );
        expect(width, 'the category box keeps a modest width (measured)').toBeGreaterThan(100);
        expect(width, 'the category box keeps a modest width (measured)').toBeLessThanOrEqual(200);
        await tab.click(category);
        await tab.waitForSelector('[role="option"]');
        const open = await listing(tab);
        expect(open.options).toEqual(['Backlog', 'Active', 'In review', 'Shipped', 'To test (verify)', 'Closed']);
        expect(open.hasSearch, 'six options: no search field').toBe(false);
        expect(open.listScrolls, 'six options: no scroll bar').toBe(false);
        if (viewport.phone) {
          expect(open.asDialog).toBe(true);
          expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
          expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
        }
        if (shotsDir !== '') await tab.waitForTimeout(450);
        if (shotsDir !== '')
          await tab.screenshot({
            animations: 'disabled',
            path: join(shotsDir, `${viewport.name}-light-lane-category.png`),
          });
        await tab.locator('[role="option"]', { hasText: 'In review' }).click();
        expect(await tab.textContent(category)).toContain('In review');
        // A gate's outcome: the lane the option goes to.
        const outcome = '[role="combobox"][aria-label^="Outcome of option 1 of To test"]';
        await tab.click(outcome);
        await tab.locator('[role="option"]', { hasText: 'Go to Todo' }).click();
        expect(await tab.textContent(outcome)).toContain('Go to Todo');
        // Where a deleted lane's tasks go: Delete stays disabled until a lane is chosen.
        await tab.click('button[aria-label="Delete Implement"]');
        const target = '[role="combobox"][aria-label="Where its tasks go"]';
        await tab.waitForSelector(target);
        expect(await tab.isDisabled('[data-lane-delete] button[data-variant="danger"]')).toBe(true);
        await tab.click(target);
        await tab.locator('[role="option"]', { hasText: 'Review/CI' }).click();
        expect(await tab.textContent(target)).toContain('Review/CI');
        expect(await tab.isDisabled('[data-lane-delete] button[data-variant="danger"]')).toBe(false);
        if (shotsDir !== '') await tab.waitForTimeout(450);
        if (shotsDir !== '')
          await tab.screenshot({
            animations: 'disabled',
            path: join(shotsDir, `${viewport.name}-light-lane-delete.png`),
          });
      } finally {
        await context.close();
      }
    });
});
