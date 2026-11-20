/**
 * THE AGENDA'S LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the
 * owner's line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear
 * in the middle as a modal ... like a combo box". Both places the agenda chose from a list (the ⋯ menu's version picker and
 * the version compare's From / To) are asserted:
 *
 *   no `<select>` in either scene; a click opens a listbox (1280) or a CENTRED dialog (390, touch); a pick writes the same
 *   thing a native select did (the menu says which version it is showing; the compare reads the picked version); and a press
 *   inside the picker's list does NOT count as a press outside the ⋯ menu (the menu stays open under it).
 *
 * Set `FY_AGENDA_SELECT_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_SELECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the agenda select scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  scene: 'menu' | 'diff',
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

/** The open list: a popover listbox (mouse) or a dialog (phone), and the geometry the owner's line is about. */
const listing = async (tab: Page) =>
  await tab.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.fy-dialog [role="dialog"]');
    const popover = document.querySelector<HTMLElement>('[data-select-popover]');
    const box = (dialog ?? popover)?.getBoundingClientRect();
    return {
      asDialog: dialog !== null,
      asPopover: popover !== null,
      centreDx: box === undefined ? null : Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
      centreDy: box === undefined ? null : Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
      options: [...document.querySelectorAll('[role="option"]')].map(
        option => option.querySelector('[data-label]')?.textContent ?? '',
      ),
      selects: document.querySelectorAll('select').length,
    };
  });

describe('the agenda picks from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`the ⋯ menu's version picker opens as ${viewport.phone ? 'a centred dialog' : 'a listbox'} and a pick shows that version (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('menu', viewport, theme);
        try {
          await tab.waitForSelector('.fy-item-view__bar [data-agenda-menu-toggle]:visible', { timeout: 8_000 });
          await tab.click('.fy-item-view__bar [data-agenda-menu-toggle]:visible');
          const picker = '[data-agenda-menu] [data-agenda-version-picker] [role="combobox"]';
          await tab.waitForSelector(picker);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          await tab.click(picker);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length).toBe(2);
          expect(open.options[0]).toMatch(/^v2 of 2/u);
          expect(open.options[1]).toMatch(/^v1 of 2/u);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover, 'a popover under the button').toBe(true);
          }
          if (shotsDir !== '')
            await tab.screenshot({
              animations: 'disabled',
              path: join(shotsDir, `${viewport.name}-${theme}-menu-open.png`),
            });
          // A press inside the list is not a press outside the ⋯ menu: the menu is still there to receive the pick.
          await tab.locator('[role="option"]', { hasText: 'v1 of 2' }).click();
          await tab.waitForSelector('[data-agenda-shown-version]');
          expect(await tab.textContent('[data-agenda-shown-version]')).toBe('Showing v1');
        } finally {
          await context.close();
        }
      });

  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`the compare's From / To pick a version and read it (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('diff', viewport, theme);
        try {
          await tab.waitForSelector('[data-agenda-diff-from] [role="combobox"]');
          expect(await tab.locator('select').count()).toBe(0);
          // Never looked: the default pair runs from the first version to the latest.
          expect(await tab.textContent('[data-agenda-diff-basis]')).toContain('v1 to v3');
          // From and To are the same width, whatever version each one shows (measured).
          const widths = await tab.evaluate(() =>
            ['from', 'to'].map(
              which =>
                document.querySelector(`[data-agenda-diff-${which}] [role="combobox"]`)?.getBoundingClientRect()
                  .width ?? -1,
            ),
          );
          expect(
            Math.abs((widths[0] ?? 0) - (widths[1] ?? 99)),
            `From ${String(widths[0])}px, To ${String(widths[1])}px`,
          ).toBeLessThanOrEqual(1);
          await tab.click('[data-agenda-diff-from] [role="combobox"]');
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length).toBe(3);
          if (viewport.phone) {
            expect(open.asDialog).toBe(true);
            expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
          }
          if (shotsDir !== '') await tab.waitForTimeout(450);
          if (shotsDir !== '')
            await tab.screenshot({
              animations: 'disabled',
              path: join(shotsDir, `${viewport.name}-${theme}-diff-open.png`),
            });
          await tab.locator('[role="option"]', { hasText: /^v2 ·/u }).click();
          await tab.waitForFunction(
            () => document.querySelector('[data-agenda-diff-basis]')?.textContent === 'v2 to v3',
          );
          const loads = await tab.evaluate(() => (window as unknown as { __loads: number[] }).__loads);
          expect(new Set(loads)).toEqual(new Set([1, 2, 3]));
          // Esc closes a list and gives the focus back to its button.
          await tab.click('[data-agenda-diff-to] [role="combobox"]');
          await tab.keyboard.press('Escape');
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          expect(await tab.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('To');
        } finally {
          await context.close();
        }
      });
});
