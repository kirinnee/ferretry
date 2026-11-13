/**
 * THE OPEN ITEM'S ⋯ MENU TAKES KEYBOARD FOCUS AND SITS UNDER EVERY DIALOG, in a real browser, over fake data
 * (`fixtures/inbox-item-menu-layers-scene.tsx`): the real Inbox page opened on an item, plus the shell's real command bar.
 *
 *  - FOCUS: Enter on ⋯ puts focus on the menu's first control (it used to stay on ⋯: the focus call ran while the popover
 *    was still `visibility: hidden`, before it was placed, and a browser refuses focus into hidden content). Esc closes it
 *    and focus returns to ⋯.
 *  - LAYERS: Cmd/Ctrl+K while the menu is open draws the command bar above it — the menu neither paints over the scrim nor
 *    takes a click through it.
 *
 * Set `FY_ITEM_MENU_SHOTS_DIR` to keep `<viewport>-item-menu-focus.png` and `<viewport>-item-menu-and-command-bar.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ITEM_MENU_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-item-menu-layers-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/inbox-item-menu-layers-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the item menu layers scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
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

const openPage = async (viewport: (typeof VIEWPORTS)[number]) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-light`);
  await tab.waitForSelector('.fy-item-view__bar [data-agenda-menu-toggle]:visible', { timeout: 8_000 });
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('the open item’s ⋯ menu moves keyboard focus in (wide)', () => {
  it('Enter on ⋯ focuses the first control inside the menu, and Esc gives focus back to ⋯', async () => {
    const { tab, close } = await openPage(VIEWPORTS[0]);
    try {
      await tab.locator('.fy-item-view__bar [data-agenda-menu-toggle]:visible').focus();
      await tab.keyboard.press('Enter');
      await tab.locator('[data-agenda-menu="popover"]').waitFor({ state: 'visible' });
      await tab.waitForTimeout(300);
      const focused = await tab.evaluate(() => {
        const popover = document.querySelector('[data-agenda-menu="popover"]');
        const active = document.activeElement;
        const first = popover?.querySelector(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href]',
        );
        return {
          inside: popover?.contains(active) === true,
          first: active === first,
          html: active?.outerHTML.slice(0, 120) ?? null,
        };
      });
      expect(focused.inside, `focus is inside the menu (it is on ${focused.html})`).toBe(true);
      expect(focused.first, 'on its first control').toBe(true);
      await shot(tab, '1280-item-menu-focus');
      await tab.keyboard.press('Escape');
      await tab.locator('[data-agenda-menu="popover"]').waitFor({ state: 'detached' });
      const back = await tab.evaluate(() => document.activeElement?.hasAttribute('data-agenda-menu-toggle') === true);
      expect(back, 'focus returns to ⋯').toBe(true);
    } finally {
      await close();
    }
  });
});

describe('the command bar over an open item menu', () => {
  for (const viewport of VIEWPORTS)
    it(`the bar's scrim, not the menu, takes the click at the menu's centre (${viewport.name})`, async () => {
      const { tab, close } = await openPage(viewport);
      try {
        await tab.click('.fy-item-view__bar [data-agenda-menu-toggle]:visible');
        await tab.waitForSelector('[data-agenda-menu] [data-agenda-menu-snooze]');
        await tab.waitForTimeout(300);
        await tab.keyboard.press('Control+k');
        await tab.locator('[role="combobox"]').waitFor({ state: 'visible' });
        await tab.waitForTimeout(200);
        const result = await tab.evaluate(() => {
          const menu = document.querySelector('[data-agenda-menu]');
          if (menu === null) return { menuOpen: false, covered: true };
          const box = menu.getBoundingClientRect();
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { menuOpen: true, covered: !(at !== null && menu.contains(at)) };
        });
        await shot(tab, `${viewport.name}-item-menu-and-command-bar`);
        // A menu closed by the dialog opening is as good as one painted under it: what must not happen is a live, clickable menu above the scrim.
        expect(result.covered, 'a click where the menu is does not reach the menu').toBe(true);
      } finally {
        await close();
      }
    });
});
