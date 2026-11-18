/**
 * A FERRET WITH A PENDING ASK SHOWS IT, in a real browser, over fake data (`fixtures/ferret-asks-scene.tsx`): the REAL app
 * over the REAL generated plugins (Conversation's chat and composer, Agenda's line above it), a fake machine behind them.
 *
 *  - agenda mode ON: the Agenda pill sits above the composer and says how many asks wait; the side toggle draws NO count
 *    (the same asks are not said twice).
 *  - agenda mode OFF: the chat draws no line (the asks live in the side column), so the CLOSED column's toggle carries the
 *    count, and its label says it. On a phone the Agenda chip is the way in, and the line is Conversation's to draw.
 *  - the top nav is 44px tall on a phone, 32px at a desk.
 *
 * Set `FY_ASKS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (2x).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ASKS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-asks-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/ferret-asks-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the asks scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const open = async (viewport: Viewport, mode: 'light' | 'dark', query: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: 2,
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
  await tab.goto(`${origin}/d/ws/ferrets/zoe/chat?theme=studio-${mode}&${query}`);
  try {
    await tab.waitForSelector(ready, { timeout: 20_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('a ferret with a pending ask', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`at ${viewport.name} in ${mode}: agenda mode on — the Agenda pill sits above the composer and counts the ask`, async () => {
        const { tab, close } = await open(viewport, mode, 'agenda=on&asks=2', '[data-agenda-line]');
        try {
          await shot(tab, `${viewport.name}-${mode}-agenda-on`);
          const pill = await tab.evaluate(() => {
            const line = document.querySelector('[data-agenda-line]')?.getBoundingClientRect();
            const composer = document
              .querySelector('[data-session-input] textarea, [data-session-input] [contenteditable]')
              ?.getBoundingClientRect();
            return {
              text: document.querySelector('[data-agenda-line]')?.textContent ?? '',
              lineBottom: line?.bottom ?? -1,
              composerTop: composer?.top ?? -1,
            };
          });
          expect(pill.text).toContain('2 need you');
          expect(pill.lineBottom, 'the pill is above the composer').toBeLessThanOrEqual(pill.composerTop);
          // The line is drawn, so the toggle (a desk has one; a phone has chips instead) carries no badge.
          expect(await tab.locator('[data-side-toggle-count]').count(), 'no badge beside the pill').toBe(0);
          if (!viewport.phone)
            expect(await tab.locator('[data-side-toggle]').getAttribute('aria-label')).toBe('Show side panels');
        } finally {
          await close();
        }
      });
    }

  for (const mode of ['light', 'dark'] as const)
    it(`at 1280 in ${mode}: agenda mode off — no line, and the closed side toggle carries the count`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'agenda=off&asks=3', '[data-side-toggle-count]');
      try {
        await shot(tab, `1280-${mode}-agenda-off-toggle`);
        expect(await tab.locator('[data-agenda-line]').count(), 'the chat draws no agenda line').toBe(0);
        expect(await tab.locator('[data-side-toggle-count]').textContent()).toBe('3');
        expect(await tab.locator('[data-side-toggle]').getAttribute('aria-label')).toBe(
          'Show side panels, 3 asks wait on you',
        );
        const box = await tab.evaluate(() => {
          const count = document.querySelector('[data-side-toggle-count]')?.getBoundingClientRect();
          return { right: count?.right ?? 9_999, width: window.innerWidth };
        });
        expect(box.right, 'the count stays on screen').toBeLessThanOrEqual(box.width);
      } finally {
        await close();
      }
    });

  for (const mode of ['light', 'dark'] as const)
    it(`at 390 in ${mode}: agenda mode off — the phone has chips, no toggle, and the page does not overflow`, async () => {
      const { tab, close } = await open(VIEWPORTS[1], mode, 'agenda=off&asks=3', '[data-session-input]');
      try {
        await shot(tab, `390-${mode}-agenda-off`);
        expect(await tab.locator('[data-side-toggle]').count()).toBe(0);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await close();
      }
    });
});

describe('the top nav touch target', () => {
  it('is 44px tall at phone width and 32px at a desk, when the layout puts the nav on top', async () => {
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport, 'light', 'agenda=on', '[data-session-input]');
      try {
        // The default layout puts the nav on top at a desk; at phone width it is the bottom bar. Force the row either way.
        // The chat page itself puts the bar of places away behind its one slim row (`data-chat-chrome`), so the frame is
        // taken off the chat chrome first: it is the nav's own row that is measured, not the chat's.
        const height = await tab.evaluate(() => {
          document.querySelector('.fy-frame')?.removeAttribute('data-chat-chrome');
          const nav = document.querySelector('.fy-nav');
          nav?.classList.add('fy-nav--top');
          nav?.classList.remove('fy-nav--bottom');
          return document.querySelector('.fy-nav--top .fy-nav__item')?.getBoundingClientRect().height ?? -1;
        });
        if (viewport.phone) expect(height).toBeGreaterThanOrEqual(44);
        else expect(height).toBeLessThan(44);
      } finally {
        await close();
      }
    }
  });
});
