/**
 * A PAGE THE AGENT OPENS SHOWS AT ONCE, in a real browser, over fake data: the REAL app over the REAL generated plugins
 *   (`fixtures/ferret-asks-scene.tsx`). The fake daemon sends `browsers.page-changed` the way Browsers' daemon does, and Browsers'
 *   app-wide listener (`shell.background`) hears it on every page.
 *
 *  - at a desk the column is on the Console; the agent opens a page and the Browser tab is on show;
 *  - another ferret's page does not move it;
 *  - on the ferrets list, where no chat is open, the ferret's row gets the dot, and it clears once that ferret's Browser panel is seen;
 *  - on a phone the Browser chip comes on screen, except while a sign-in card modal is open (`data-fy-input-modal="open"`).
 *
 * Set `FY_REVEAL_SHOTS_DIR` to keep `<viewport>-<mode>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const shotsDir = process.env.FY_REVEAL_SHOTS_DIR ?? '';
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-reveal-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(import.meta.dir, 'fixtures/ferret-asks-scene.tsx'),
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ferret scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
}
const DESK: Viewport = { name: '1440', width: 1_440, height: 900, phone: false };
const PHONE: Viewport = { name: '390', width: 390, height: 844, phone: true };
type Mode = 'light' | 'dark';
const MODES: readonly Mode[] = ['light', 'dark'];
const ASIDE = '[data-ferret-side]';

const open = async (viewport: Viewport, mode: Mode, path = 'ferrets/zoe/chat') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(15_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/d/ws/${path}?theme=studio-${mode}&agenda=off&asks=0`);
  const list = path === 'ferrets';
  try {
    // The fake ferret is the agent's, not the owner's: it is listed under "All".
    if (list) await tab.getByText('All', { exact: true }).first().click();
    await tab.waitForSelector(
      list ? '[data-sbar-row="zoe"]' : viewport.phone ? '[data-phone-chip]' : '[data-side-toggle]',
      {
        timeout: 20_000,
      },
    );
  } catch (error) {
    throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
  }
  if (!viewport.phone && !list) {
    await tab.locator('[data-side-toggle]:visible').click();
    await tab.waitForSelector(`${ASIDE} [role="tab"]`);
  }
  // The shell connects, then the listener attaches: wait for the feed before the first event.
  await tab.waitForTimeout(500);
  return { tab, problems, close: async () => await context.close() };
};

const calm = async (tab: Page): Promise<void> => {
  await tab.waitForFunction(() => document.querySelector('[data-loading]') === null, undefined, { timeout: 20_000 });
  await tab.waitForTimeout(250);
};
const shot = async (tab: Page, viewport: Viewport, mode: Mode, name: string): Promise<void> => {
  await calm(tab);
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-${name}.png`) });
};
const opened = async (tab: Page, ferret: string, page: string): Promise<void> => {
  await tab.evaluate(
    ([who, id]) =>
      (window as unknown as { __emit: (n: string, p: unknown) => void }).__emit('browsers.page-changed', {
        ferret: who,
        page: id,
        change: 'opened',
      }),
    [ferret, page],
  );
  await tab.waitForTimeout(400);
};
const shown = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(
    aside =>
      [...document.querySelectorAll(`${aside} [data-panel][data-phone-shown]`)]
        .filter(node => (node as HTMLElement).getBoundingClientRect().height > 0)
        .map(node => node.getAttribute('data-panel') ?? ''),
    ASIDE,
  );
const phoneTab = async (tab: Page): Promise<string | null> =>
  await tab.evaluate(() => document.querySelector('[data-phone-workspace]')?.getAttribute('data-phone-tab') ?? null);

describe('a page the agent opens, at a desk', () => {
  for (const mode of MODES) {
    it(`${mode}: the Browser tab is on show, and another ferret's page leaves it where it was`, async () => {
      const { tab, problems, close } = await open(DESK, mode);
      try {
        const before = await shown(tab);
        expect(before).not.toContain('browsers.browser');
        await shot(tab, DESK, mode, 'before');
        await opened(tab, 'kai', 'p1');
        expect(await shown(tab), 'another ferret does not move the panel').toEqual(before);
        await opened(tab, 'zoe', 'p2');
        expect(await shown(tab)).toEqual(['browsers.browser']);
        await shot(tab, DESK, mode, 'revealed');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

describe('a page the agent opens, on a phone', () => {
  for (const mode of MODES) {
    it(`${mode}: the Browser chip comes on screen, but not over an open sign-in card`, async () => {
      const held = await open(PHONE, mode);
      try {
        expect(await phoneTab(held.tab)).toBe('chat');
        await held.tab.evaluate(() => document.documentElement.setAttribute('data-fy-input-modal', 'open'));
        await opened(held.tab, 'zoe', 'p1');
        expect(await phoneTab(held.tab), 'a sign-in card is open: the chat stays').toBe('chat');
        await shot(held.tab, PHONE, mode, 'held-by-card');
        await held.tab.evaluate(() => document.documentElement.removeAttribute('data-fy-input-modal'));
        await opened(held.tab, 'zoe', 'p2');
        expect(await phoneTab(held.tab)).toBe('browsers.browser');
        await shot(held.tab, PHONE, mode, 'revealed');
        expect(held.problems).toEqual([]);
      } finally {
        await held.close();
      }
    });
  }
});

const MARK = '[data-browser-opened-mark]';

describe('a page the agent opens, on the ferrets list (no chat open)', () => {
  for (const viewport of [DESK, PHONE])
    for (const mode of MODES) {
      it(`${viewport.name} ${mode}: the ferret's row gets the dot, and it clears once its Browser panel is seen`, async () => {
        const { tab, problems, close } = await open(viewport, mode, 'ferrets');
        try {
          expect(await tab.locator(MARK).count()).toBe(0);
          await shot(tab, viewport, mode, 'list-before');
          await opened(tab, 'zoe', 'p3');
          await tab.locator(MARK).first().waitFor({ state: 'visible' });
          await shot(tab, viewport, mode, 'list-dot');
          // Looking at that ferret's Browser panel is what clears it.
          await tab.locator('[data-sbar-session="zoe"]').click();
          if (viewport.phone) await tab.locator('[data-phone-chip="browsers.browser"]').click();
          else {
            await tab.locator('[data-side-toggle]:visible').click();
            await tab.getByRole('tab', { name: /browser/i }).click();
          }
          await tab.waitForFunction(m => document.querySelector(m) === null, MARK, { timeout: 10_000 });
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
});
