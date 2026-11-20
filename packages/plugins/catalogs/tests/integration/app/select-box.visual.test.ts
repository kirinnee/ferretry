/**
 * THE CATALOGS' LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the owner's
 * line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search". One real control per sheet is driven from open to
 * submit and the request the fake machine receives is asserted exactly:
 *
 *   add     "Add to catalog" over nine catalogs: open the Catalog list, type "sec" (a search field: more than seven), pick,
 *           Preview, Add. The machine is sent the preview and the add for THAT catalog.
 *   share   the invite's "The link works for" list (five options: no search field, no scroll bar): pick "8 hours", Confirm.
 *           The machine is sent a mint carrying `expiresIn: '8h'`.
 *
 * At 1280 the list is a popover under the button; at 390 (touch) a CENTRED dialog over the sheet. Light and dark.
 * Set `FY_CATALOGS_SELECT_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CATALOGS_SELECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-catalogs-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the catalogs select scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  scene: 'add' | 'share',
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

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
/** What the fake machine has been sent, in order. */
const callsOf = async (tab: Page): Promise<readonly Call[]> =>
  await tab.evaluate(() =>
    (window as unknown as { __calls: Call[] }).__calls.map(({ method, path, body }) => ({ method, path, body })),
  );

const snap = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.waitForTimeout(450);
  await tab.screenshot({ animations: 'disabled', path: join(shotsDir, `${name}.png`) });
};

const SECURITY = `cat_${'d'.repeat(22)}`;
const SKILL_SOURCE = { kind: 'skill', skill: '/home/k/.claude/skills/pdf-tools/SKILL.md' };

describe('the catalogs pick from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`add to a catalog: open, type, pick, Preview, Add sends the exact requests (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('add', viewport, theme);
        try {
          const picker = '[data-catalog-picker] [role="combobox"]';
          await tab.waitForSelector(picker);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          await tab.click(picker);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length, 'nine catalogs and “A new catalog…”').toBe(10);
          expect(open.options[0]).toBe('Team skills · 1 item');
          expect(open.options.at(-1)).toBe('A new catalog…');
          expect(open.hasSearch, 'a list this long has a search field').toBe(true);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone, over the sheet').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover, 'a popover under the button on a mouse').toBe(true);
          }
          await snap(tab, `${viewport.name}-${theme}-add-open`);
          await tab.keyboard.type('sec');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
          expect((await listing(tab)).options).toEqual(['Security · 1 item']);
          await snap(tab, `${viewport.name}-${theme}-add-filtered`);
          await tab.keyboard.press('ArrowDown');
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          expect(await tab.textContent(picker)).toContain('Security · 1 item');
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
          // Nothing is written by choosing: only the list read has been sent.
          expect((await callsOf(tab)).map(call => `${call.method} ${call.path}`)).toEqual(['GET /v1/catalogs']);
          await tab.click('[data-catalog-preview]');
          await tab.waitForSelector('[data-catalog-add]');
          await tab.click('[data-catalog-add]');
          await tab.waitForSelector('[data-catalog-landed]');
          const sent = await callsOf(tab);
          expect(sent.map(call => `${call.method} ${call.path}`)).toEqual([
            'GET /v1/catalogs',
            `POST /v1/catalogs/${SECURITY}/items/preview`,
            `POST /v1/catalogs/${SECURITY}/items`,
          ]);
          expect(sent[1]?.body, 'the preview names the skill').toEqual({ source: SKILL_SOURCE });
          expect(sent[2]?.body, 'the add is bound to the previewed digest').toEqual({
            source: SKILL_SOURCE,
            digest: `sha256:${'ab'.repeat(32)}`,
          });
          expect(await tab.textContent('[data-catalog-landed]')).toContain('Saved to Security');
          await snap(tab, `${viewport.name}-${theme}-add-saved`);
        } finally {
          await context.close();
        }
      });

  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`the invite's expiry: five options, no search, no scroll bar; Confirm mints with the pick (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('share', viewport, theme);
        try {
          const expiry = '[data-share-expiry] [role="combobox"]';
          await tab.waitForSelector(expiry);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.textContent(expiry)).toContain('15 minutes');
          await tab.fill('[data-share-user-id]', 'crew');
          await tab.click(expiry);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options).toEqual(['15 minutes', '1 hour', '3 hours', '8 hours', '1 day']);
          expect(open.hasSearch, 'five options: no search field').toBe(false);
          expect(open.listScrolls, 'five options: no scroll bar').toBe(false);
          if (viewport.phone) {
            expect(open.asDialog).toBe(true);
            expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover).toBe(true);
          }
          await snap(tab, `${viewport.name}-${theme}-expiry-open`);
          await tab.locator('[role="option"]', { hasText: '8 hours' }).click();
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          expect(await tab.textContent(expiry)).toContain('8 hours');
          expect(
            (await callsOf(tab)).filter(call => call.method === 'POST'),
            'nothing minted by choosing',
          ).toEqual([]);
          await tab.click('[data-share-confirm]');
          await tab.waitForFunction(() =>
            (window as unknown as { __calls: { method: string }[] }).__calls.some(call => call.method === 'POST'),
          );
          const minted = (await callsOf(tab)).filter(call => call.method === 'POST');
          expect(minted.map(call => call.path)).toEqual(['/v1/catalog-shares']);
          expect(minted[0]?.body).toEqual({
            catalogIds: [`cat_${'a'.repeat(22)}`],
            member: { name: 'crew' },
            expiresIn: '8h',
            uses: { kind: 'single' },
          });
          await snap(tab, `${viewport.name}-${theme}-expiry-minted`);
        } finally {
          await context.close();
        }
      });
});
