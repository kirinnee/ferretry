/**
 * THE RUNTIMES PLUGIN'S LISTS ARE THE APP'S SELECT BOX, in a real browser over fake data (`fixtures/select-box-scene.tsx`): the
 * owner's line "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in
 * the middle as a modal ... like a combo box, where people can type to search". Two real controls are driven end to end, with
 * nine runtimes so the list is long enough to search:
 *
 *   New ferret's runtime field   open -> type -> pick -> Start: the exact request the fake `/v1/ferrets` route receives
 *   Settings › Default runtime   open -> type -> pick -> Save: the exact change the fake proposals route receives
 *
 * at 1280 (a popover under the box) and at 390 with touch (a CENTRED dialog), light and dark. Both scenes hold 0 `select`
 * elements. Set `FY_RUNTIMES_SELECT_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RUNTIMES_SELECT_SHOTS_DIR ?? '';

interface Received {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
/** Every request the fake daemon's routes were sent (the page's own asset loads are not recorded). */
const received: Received[] = [];

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-runtimes-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the runtimes select scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (url.pathname.startsWith('/v1/')) {
        received.push({
          method: request.method,
          path: url.pathname,
          contentType: request.headers.get('content-type'),
          body: await request.json().catch(() => null),
        });
        return Response.json({ ok: true });
      }
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
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['light', 'dark'] as const;

const openScene = async (
  scene: 'start' | 'default',
  viewport: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
  label = '',
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
  await tab.goto(
    `${origin}/?scene=${scene}&theme=studio-${theme}${label === '' ? '' : `&label=${encodeURIComponent(label)}`}`,
  );
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
      headings: [...document.querySelectorAll('.fy-sb__heading')].map(heading => heading.textContent ?? ''),
      hasSearch: input !== null,
      searchFocused: input !== null && document.activeElement === input,
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

/**
 * The closed box at rest: what it shows, and whether the part that tells two accounts apart is READ (laid out inside the
 * box, wrapped onto a second line if need be) and not cut by an ellipsis or a clip, which is what a phone's narrow box
 * did when the account came last in the words.
 */
const closedBox = async (tab: Page, box: string) =>
  await tab.evaluate(selector => {
    const trigger = document.querySelector<HTMLElement>(selector);
    const value = trigger?.querySelector<HTMLElement>('.fy-sb__value');
    if (trigger === null || trigger === undefined || value === null || value === undefined) return null;
    const at = trigger.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(value);
    const text = range.getBoundingClientRect();
    return {
      text: value.textContent ?? '',
      ellipsis: value.scrollWidth > value.clientWidth + 1 || value.scrollHeight > value.clientHeight + 1,
      inside: text.left >= at.left - 1 && text.right <= at.right + 1 && text.bottom <= at.bottom + 1,
    };
  }, box);

const expectAccountRead = async (tab: Page, box: string, words: string): Promise<void> => {
  const shown = await closedBox(tab, box);
  expect(shown?.text, 'the closed box says which account').toBe(words);
  expect(shown?.ellipsis, 'nothing of it is cut off').toBe(false);
  expect(shown?.inside, 'all of it lies inside the box').toBe(true);
};

const requestsTo = (path: string): Received[] => received.filter(request => request.path === path);

const shoot = async (tab: Page, viewport: string, theme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.waitForTimeout(450);
  await tab.screenshot({ animations: 'disabled', path: join(shotsDir, `${viewport}-${theme}-${name}.png`) });
};

describe('the runtimes plugin picks from lists with the app’s select box', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`New ferret: open the runtime list, type to narrow, pick, Start sends that runtime (${viewport.name}, ${theme})`, async () => {
        received.length = 0;
        const { context, tab } = await openScene('start', viewport, theme);
        try {
          const box = '[data-runtime-select] [role="combobox"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          expect(await tab.locator('input[type="radio"]').count(), 'no radio buttons either').toBe(0);
          // The first usable runtime is already chosen, as before.
          await expectAccountRead(tab, box, 'Claude · your terminal sign-in — personal@studio.example');
          // The page's own label still names the field it points at.
          expect(await tab.getAttribute(box, 'id')).toBe('runtime-field');
          expect(await tab.getAttribute(box, 'aria-label'), 'announced as the visible label says').toBe('Runtime');
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length, 'nine runtimes').toBe(9);
          expect(open.headings, 'grouped under their harness').toEqual(['Claude', 'Codex']);
          console.info(
            `MEASURED runtime ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog}`,
          );
          expect(open.hasSearch, 'a list this long has a search field').toBe(true);
          expect(open.searchFocused, 'the search field has the focus').toBe(true);
          if (viewport.phone) {
            expect(open.asDialog, 'a dialog on a phone').toBe(true);
            expect(open.centreDx ?? 99, 'dialog centred, x').toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99, 'dialog centred, y').toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover, 'a popover under the box on a desktop').toBe(true);
          }
          await shoot(tab, viewport.name, theme, 'runtime-open');
          await tab.keyboard.type('night');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
          expect((await listing(tab)).options).toEqual(['Codex · your terminal sign-in — night@studio.example']);
          await shoot(tab, viewport.name, theme, 'runtime-filtered');
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          await expectAccountRead(tab, box, 'Codex · your terminal sign-in — night@studio.example');
          expect(await tab.textContent('[data-chosen]'), 'the page learned which runtime was chosen').toContain(
            'model:',
          );
          expect(requestsTo('/v1/ferrets'), 'nothing is sent before Start').toEqual([]);
          await tab.click('[data-start]');
          await tab.waitForSelector('[data-started]:not(:empty)');
          expect(requestsTo('/v1/ferrets'), 'exactly one request, carrying the picked runtime').toEqual([
            {
              method: 'POST',
              path: '/v1/ferrets',
              contentType: 'application/json',
              body: { runtime: 'codex-night', folder: '/work/project' },
            },
          ]);
          expect((await listing(tab)).pageOverflowsX, 'no horizontal page overflow').toBe(false);
          await shoot(tab, viewport.name, theme, 'runtime-started');
        } finally {
          await context.close();
        }
      });

  it('Move: the box announces the visible label (Agent wrapper), not a generic "Runtime", and titles its dialog with it', async () => {
    const { context, tab } = await openScene('start', VIEWPORTS[0], 'light', 'Agent wrapper');
    try {
      const box = '[data-runtime-select] [role="combobox"]';
      await tab.waitForSelector(box);
      expect(await tab.getAttribute(box, 'aria-label')).toBe('Agent wrapper');
      await tab.click(box);
      await tab.waitForSelector('[role="listbox"]');
      expect(await tab.getAttribute('[role="listbox"]', 'aria-label')).toBe('Agent wrapper');
    } finally {
      await context.close();
    }
  });

  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`Default runtime: open, type to narrow, pick, Save writes the default (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await openScene('default', viewport, theme);
        try {
          const box = '[data-default-runtime-select] [role="combobox"]';
          await tab.waitForSelector(box);
          expect(await tab.locator('select').count(), 'no native select on the page').toBe(0);
          await expectAccountRead(tab, box, 'Claude · your terminal sign-in — personal@studio.example');
          await tab.click(box);
          await tab.waitForSelector('[role="option"]');
          const open = await listing(tab);
          expect(open.options.length, 'nine runtimes').toBe(9);
          console.info(
            `MEASURED default ${viewport.name} ${theme}: dx=${open.centreDx?.toFixed(1)} dy=${open.centreDy?.toFixed(1)} options=${open.options.length} dialog=${open.asDialog}`,
          );
          expect(open.hasSearch).toBe(true);
          if (viewport.phone) {
            expect(open.asDialog).toBe(true);
            expect(open.centreDx ?? 99).toBeLessThanOrEqual(8);
            expect(open.centreDy ?? 99).toBeLessThanOrEqual(8);
          } else {
            expect(open.asPopover).toBe(true);
          }
          await shoot(tab, viewport.name, theme, 'default-open');
          await tab.keyboard.type('team');
          await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
          expect((await listing(tab)).options).toEqual(['Codex · your terminal sign-in — team@studio.example']);
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.querySelector('[role="option"]') === null);
          await expectAccountRead(tab, box, 'Codex · your terminal sign-in — team@studio.example');
          const sent = async () =>
            await tab.evaluate(() =>
              (
                window as unknown as {
                  __calls: { route: string; params?: unknown; body: unknown }[];
                }
              ).__calls
                .filter(call => call.route.startsWith('POST'))
                .map(call => ({ route: call.route, params: call.params, body: call.body })),
            );
          expect(await sent(), 'nothing is written before Save').toEqual([]);
          await tab.click('[data-change-submit]');
          // The apply ANSWERED: the scene's apply route only answers the proposal id the scene staged, and the tab
          // closes the pick (the box returns to the saved default) only for an applied change.
          await tab.waitForFunction(() => (window as unknown as { __applied?: unknown[] }).__applied?.length === 1);
          expect(await sent(), 'the exact proposal, then the exact apply of that proposal id').toEqual([
            {
              route: 'POST /v1/runtimes/proposals',
              params: undefined,
              body: {
                change: {
                  kind: 'machine.settings',
                  agentPermissions: 'auto',
                  defaultRuntime: 'codex-team',
                  agentControl: {
                    terminals: true,
                    browsers: true,
                    files: true,
                    ferretrySettings: false,
                    pageScripts: false,
                  },
                  browserMode: 'headless',
                  browserProxy: null,
                  browserPorts: 'random',
                  browserFirewallFailure: 'warn',
                  autoResume: true,
                  agendaMode: false,
                  publicUsageFeed: false,
                },
              },
            },
            {
              route: 'POST /v1/runtimes/proposals/:proposalId/apply',
              params: { proposalId: 'fy_fprop_abcdefghijklmnopqrstuv' },
              body: {},
            },
          ]);
          expect(
            await tab.evaluate(() => (window as unknown as { __applied: unknown[] }).__applied),
            'the daemon answered the apply with a committed outcome',
          ).toEqual([{ proposalId: 'fy_fprop_abcdefghijklmnopqrstuv', outcome: 'applied' }]);
          await tab.waitForFunction(
            selector =>
              document
                .querySelector(selector)
                ?.textContent?.includes('Claude · your terminal sign-in — personal@studio.example') === true,
            box,
          );
          await shoot(tab, viewport.name, theme, 'default-saved');
        } finally {
          await context.close();
        }
      });
});
