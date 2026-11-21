/**
 * THE WARDEN'S LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the owner's
 * line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search". Two real controls are driven end to end:
 *
 *   Ask the Warden › What should it look at?   open -> pick -> Send: the exact request the fake `investigate` port receives
 *   Warden page › Daemon filter                open -> (type) -> pick: the page learns which daemon was chosen
 *
 * at 1280 (a popover under the box) and at 390 with touch (a CENTRED dialog with a focused search field, even for three
 * options), light and dark. Both scenes hold 0 `select` elements. Set `FY_WARDEN_SELECT_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WARDEN_SELECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Warden select scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  scene: 'ask' | 'daemon',
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

describe('the Warden picks from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES) {
      it(`Ask the Warden: open the focus list, pick, Send sends that focus (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('ask', viewport, theme);
        try {
          const box = '[role="combobox"][aria-label="What should it look at?"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.textContent(box)).toContain('Why it seems stuck');
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          console.info(
            `MEASURED ask ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog} search=${open.hasSearch}`,
          );
          expect(open.options).toEqual(['Why it seems stuck', 'The recent failures', 'Everything recent']);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
            expect(open.hasSearch, 'the phone dialog always has search').toBe(true);
            expect(open.searchFocused, 'the search field has the focus').toBe(true);
          } else {
            expect(open.asPopover, 'a popover under the box on a desktop').toBe(true);
            expect(open.hasSearch, 'three options need no search on a desktop').toBe(false);
          }
          await shoot(tab, viewport.name, theme, 'ask-open');
          if (viewport.phone) {
            await tab.keyboard.type('fail');
            await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
            expect((await listing(tab)).options).toEqual(['The recent failures']);
            await shoot(tab, viewport.name, theme, 'ask-filtered');
            await tab.keyboard.press('Enter');
          } else {
            await tab.getByRole('option', { name: 'The recent failures' }).click();
          }
          await closed(tab);
          expect(await tab.textContent(box)).toContain('The recent failures');
          const sent = async () =>
            await tab.evaluate(() => (window as unknown as { __requests: unknown[] }).__requests);
          expect(await sent(), 'nothing is sent before Send').toEqual([]);
          await tab.click('[data-action-submit]');
          await tab.waitForSelector('[data-notice]:not(:empty)');
          expect(await sent(), 'exactly one request, carrying the picked focus').toEqual([
            { ferret: 'sess-1', note: 'Focus: the recent failures.' },
          ]);
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
          await shoot(tab, viewport.name, theme, 'ask-sent');
        } finally {
          await context.close();
        }
      });

      it(`Daemon filter: open, pick a daemon, the page learns the choice (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('daemon', viewport, theme);
        try {
          const box = '[role="combobox"][aria-label="Daemon"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.textContent(box)).toContain('All daemons');
          const fit = await tab.evaluate(selector => {
            const value = document.querySelector<HTMLElement>(`${selector} .fy-sb__value`);
            const button = document.querySelector<HTMLElement>(selector);

            return {
              width: button?.getBoundingClientRect().width ?? 0,
              clipped: (value?.scrollWidth ?? 0) > (value?.clientWidth ?? 0),
            };
          }, box);
          console.info(
            `MEASURED daemon button ${viewport.name} ${theme}: width=${fit.width.toFixed(0)} clipped=${fit.clipped}`,
          );
          expect(fit.clipped, 'the closed button shows "All daemons" whole, not "All dae…"').toBe(false);
          expect(await tab.getAttribute(box, 'id'), 'the visible label points at the box').not.toBeNull();
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          console.info(
            `MEASURED daemon ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog} search=${open.hasSearch}`,
          );
          expect(open.options).toEqual(['All daemons', 'Liftoff EC2', 'Liftoff MBP', 'Home NAS']);
          if (viewport.phone) {
            expect(open.asDialog).toBe(true);
            expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
            expect(open.searchFocused).toBe(true);
            await tab.keyboard.type('nas');
            await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
            await shoot(tab, viewport.name, theme, 'daemon-filtered');
            await tab.keyboard.press('Enter');
          } else {
            expect(open.asPopover).toBe(true);
            await shoot(tab, viewport.name, theme, 'daemon-open');
            await tab.getByRole('option', { name: 'Home NAS' }).click();
          }
          await closed(tab);
          expect(await tab.textContent('[data-chosen]'), 'the page learned the daemon id').toBe('daemon-nas');
          expect(await tab.textContent(box)).toContain('Home NAS');
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
        } finally {
          await context.close();
        }
      });
    }
});
