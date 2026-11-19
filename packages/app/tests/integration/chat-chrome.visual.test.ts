/**
 * THE CHAT'S TOP CHROME, MEASURED in a real browser over fake data (`fixtures/frame-scene.tsx`, `?header=modes`: the
 * ferret's header as the real chat page draws it, the name and the status with ONE "Modes" button at its end).
 *
 * The owner's words (11-18): the top bar, "esp for the chat", must be "as thin and as little as possible so we can read and see
 * as much of the chat as possible". So the number that matters is the distance from the top of the window to the chat's
 * first line, on a desktop (1440x900) and a phone (390x844), and that the page does not jump while it loads.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep the shots and `FY_CHAT_CHROME_LOG=1` to print the numbers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';
const log = process.env.FY_CHAT_CHROME_LOG === '1';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chat-chrome-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1_440, height: 900, phone: false },
  { name: 'phone-390x844', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const open = async (viewport: Viewport, path: string, ready: string, theme = 'studio-light') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  // Every layout shift from the first paint on, as the browser itself scores them.
  await tab.addInitScript(() => {
    const shifts: number[] = [];
    (window as unknown as { __shifts: number[] }).__shifts = shifts;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as unknown as { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) shifts.push(shift.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await tab.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=${theme}`);
  await tab.waitForSelector(ready, { timeout: 8_000 });
  return { tab, close: async () => await context.close() };
};

const CHAT = '/d/ws/ferrets/zoe?header=modes&relay=0';
/** `FY_CHAT_CHROME_BEFORE=1` puts the page back as it was before the slim row (the old rules are the ones keyed on `data-chat-chrome`) to measure it. */
const BEFORE = process.env.FY_CHAT_CHROME_BEFORE === '1';

/** Pixels from the top of the window to the chat's first line (the transcript's own 16px padding is the fixture's, not chrome). */
const topOfChat = async (tab: Page): Promise<number> =>
  await tab.evaluate(() => (document.querySelector('[data-transcript]')?.getBoundingClientRect().top ?? -1) as number);

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, name + '.png') });
};

describe('the chat page keeps its top chrome to one slim row', () => {
  for (const viewport of VIEWPORTS) {
    it(
      'at ' + viewport.name + ' the chat starts within one slim row of the top and nothing jumps while it loads',
      async () => {
        const { tab, close } = await open(viewport, CHAT, '[data-transcript]');
        try {
          await tab.waitForSelector('[data-ferret-header] [data-ferret-name]');
          if (BEFORE)
            await tab.evaluate(() => document.querySelector('.fy-frame')?.removeAttribute('data-chat-chrome'));
          // Let any late layout settle, then read the browser's own shift score.
          await tab.waitForTimeout(400);
          await shot(tab, viewport.name + (BEFORE ? '-chat-before' : '-chat'));
          const top = await topOfChat(tab);
          const header = await tab.evaluate(() => {
            const box = document.querySelector('[data-ferret-header]')?.getBoundingClientRect();
            return { top: box?.top ?? -1, height: box?.height ?? -1 };
          });
          const chips = await tab.evaluate(
            () => document.querySelector('[data-phone-chips]')?.getBoundingClientRect().height ?? 0,
          );
          const shifts = await tab.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);
          if (log || BEFORE)
            console.log(
              'CHAT-CHROME ' +
                (BEFORE ? 'BEFORE' : 'AFTER') +
                ' ' +
                viewport.name +
                ': first chat line at ' +
                top.toFixed(1) +
                'px (header row ' +
                header.height.toFixed(1) +
                'px at y=' +
                header.top.toFixed(1) +
                ', page chips ' +
                chips +
                'px), layout shifts ' +
                (shifts.join(',') || 'none'),
            );
          if (BEFORE) return;
          expect(top, 'the chat is drawn').toBeGreaterThan(0);
          expect(header.top, 'the header row is the first thing in the window').toBe(0);
          expect(header.height, 'one slim row').toBeLessThanOrEqual(viewport.phone ? 44 : 40);
          if (!viewport.phone) expect(top, 'the chat starts within one slim row').toBeLessThanOrEqual(40);
          expect(
            shifts.reduce((sum, value) => sum + value, 0),
            'no layout shift on load',
          ).toBe(0);
        } finally {
          await close();
        }
      },
    );
  }

  // The wide frame has no menu button on the chat: the left drawer (Find, the places) is already beside it.
  it('on a desktop the drawer sits beside the chat and there is no menu button', async () => {
    const { tab, close } = await open(VIEWPORTS[0], CHAT, '[data-transcript]');
    try {
      expect(await tab.locator('[data-chat-menu]').count()).toBe(0);
      expect(await tab.locator('.fy-drawer [data-drawer-find]').count()).toBe(1);
      for (const place of ['Ferrets', 'Agenda', 'Board'])
        expect(await tab.locator('.fy-drawer nav a', { hasText: place }).count(), place).toBeGreaterThan(0);
      await shot(tab, VIEWPORTS[0].name + '-chat-drawer');
    } finally {
      await close();
    }
  });

  it('on a phone the one button opens the drawer: Find, then the places; choosing one goes there', async () => {
    const { tab, close } = await open(VIEWPORTS[1], CHAT, '[data-chat-menu]');
    try {
      await tab.locator('[data-chat-menu]').click();
      await tab.waitForSelector('.fy-drawer--overlay [data-drawer-find]');
      await shot(tab, VIEWPORTS[1].name + '-chat-drawer');
      for (const place of ['Ferrets', 'Agenda', 'Board'])
        expect(await tab.locator('.fy-drawer--overlay nav a', { hasText: place }).count(), place).toBeGreaterThan(0);
      await tab.locator('.fy-drawer--overlay nav a', { hasText: 'Agenda' }).click();
      await tab.waitForSelector('[data-agenda-stand-in]');
      expect(await tab.locator('.fy-frame[data-chat-chrome]').count(), 'the agenda is not a chat').toBe(0);
      expect(await tab.locator('.fy-drawer--overlay').count(), 'the overlay is put away').toBe(0);
    } finally {
      await close();
    }
  });
});

describe('the machine switcher', () => {
  it('is not drawn while one machine is paired, so there is nothing to name from it either', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/agenda?relay=0&host=unnamed', '[data-agenda-stand-in]');
    try {
      await tab.waitForTimeout(500);
      expect(await tab.locator('[data-daemon-picker]').count()).toBe(0);
      expect(await tab.locator('[data-name-machine-offer]').count()).toBe(0);
    } finally {
      await close();
    }
  });
});
