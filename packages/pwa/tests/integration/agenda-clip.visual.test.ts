/**
 * A MENU OPENS INSIDE THE VIEWPORT, AND THE ANSWER-QUICKLY CARD SCROLLS WITH ITS ANSWERS IN REACH, in a real browser, on
 * a phone and a desktop, in the Studio and Neo-Brutalism themes, light and dark.
 *
 * The owner (2026-11-01): "1. snooze option opens to the left 2. the card is clipped in inbox. it also doesn't allow
 * swipe down."
 *
 *  - The REAL `AgendaItemView`: with its ⓘ panel open, "Snooze this item" opens a menu whose every edge is on screen.
 *  - The REAL `ToTestStep` in the run's own fixed-height box: the card is as long as its steps, the box scrolls, the
 *    head sits on its top edge and the answer row on its bottom edge, Done is pressable at the end of the scroll, and
 *    its snooze menu is on screen. On touch, a swipe down that starts on the title skips; one that starts in the steps
 *    is the card scrolling and skips nothing.
 *  - A card titled by its task prints the title once.
 *
 * Set `FY_CLIP_SHOTS_DIR` to keep `<viewport>-<theme>-<scene>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_CLIP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-clip-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/agenda-clip-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the clip scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const framesSettled = async (tab: Page): Promise<void> => {
  await tab.waitForFunction(() =>
    document
      .getAnimations()
      .filter(entry => entry.effect?.getComputedTiming().endTime !== Infinity)
      .every(entry => entry.playState === 'finished'),
  );
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
};

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;
const THEMES = ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'] as const;

const open = async (scene: string, name: string, theme: string, query = '') => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${theme}&scene=${scene}${query}`);
  return { tab, context, close: async () => await context.close() };
};

const insideViewport = async (tab: Page, selector: string) =>
  await tab.evaluate((query: string) => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
    };
  }, selector);

const expectOnScreen = (box: Awaited<ReturnType<typeof insideViewport>>, label: string): void => {
  expect(box.width, `${label}: has a width`).toBeGreaterThan(40);
  expect(box.left, `${label}: left edge on screen`).toBeGreaterThanOrEqual(0);
  expect(box.top, `${label}: top edge on screen`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${label}: right edge on screen`).toBeLessThanOrEqual(box.viewportWidth);
  expect(box.bottom, `${label}: bottom edge on screen`).toBeLessThanOrEqual(box.viewportHeight);
};

describe('the snooze menu in the open item', () => {
  for (const { name } of VIEWPORTS)
    for (const theme of THEMES)
      it(`opens with every edge on screen (${name}, ${theme})`, async () => {
        const { tab, close } = await open('item', name, theme);
        try {
          await tab.click('[data-agenda-info-toggle]');
          await tab.click('.fy-item-view__snooze [data-agenda-snooze]');
          await tab.waitForSelector('.fy-snooze__popover');
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '.fy-snooze__popover'), 'the menu');
          await tab.click('.fy-snooze__popover [role="menuitem"]:last-child');
          await tab.waitForSelector('.fy-snooze__custom');
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '.fy-snooze__popover'), 'the menu with its custom form');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-snooze.png`) });
        } finally {
          await close();
        }
      });
});

const scrollBox = async (tab: Page) =>
  await tab.evaluate(() => {
    const read = (query: string) => {
      const element = document.querySelector(query);
      if (element === null) throw new Error(`nothing matches ${query}`);
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height };
    };
    const step = document.querySelector('.fy-inbox-step') as HTMLElement;
    return {
      scroller: read('.fy-inbox-step'),
      head: read('.fy-totest__top'),
      actions: read('.fy-totest__actions'),
      scroll: step.scrollHeight,
      client: step.clientHeight,
      top: step.scrollTop,
    };
  });

const scrollTo = async (tab: Page, to: number | 'end'): Promise<void> => {
  await tab.evaluate((target: number | 'end') => {
    const step = document.querySelector('.fy-inbox-step') as HTMLElement;
    step.scrollTop = target === 'end' ? step.scrollHeight : target;
  }, to);
  await framesSettled(tab);
};

describe('the Answer-quickly card', () => {
  for (const { name } of VIEWPORTS)
    for (const theme of THEMES)
      it(`scrolls whole, with its head and answers on the box's edges (${name}, ${theme})`, async () => {
        const { tab, close } = await open('run', name, theme);
        try {
          await tab.waitForSelector('.fy-totest__actions');
          await framesSettled(tab);
          const first = await scrollBox(tab);
          // The card runs past its box: the test proves nothing on one that fits.
          expect(first.scroll, 'the card is taller than its box').toBeGreaterThan(first.client + 40);
          const check = async (label: string): Promise<void> => {
            const now = await scrollBox(tab);
            if (now.top > 0)
              expect(Math.abs(now.head.top - now.scroller.top), `${label}: head on the top edge`).toBeLessThanOrEqual(
                1,
              );
            expect(
              Math.abs(now.actions.bottom - now.scroller.bottom),
              `${label}: answers on the bottom edge (or at the card's own foot, at the end of it)`,
            ).toBeLessThanOrEqual(label === 'at the end' ? 24 : 1);
          };
          await check('at the top');
          await scrollTo(tab, (first.scroll - first.client) / 2);
          await check('mid-scroll');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-run-scrolled.png`) });
          await scrollTo(tab, 'end');
          await check('at the end');
          // The last step is on screen above the answers, not behind them.
          const last = await tab.evaluate(() => {
            const steps = [...document.querySelectorAll('[data-to-test-how] li')];
            const lastStep = steps.at(-1) as HTMLElement;
            const actions = document.querySelector('.fy-totest__actions') as HTMLElement;
            return {
              stepBottom: lastStep.getBoundingClientRect().bottom,
              actionsTop: actions.getBoundingClientRect().top,
            };
          });
          expect(last.stepBottom, 'the last step ends above the answers').toBeLessThanOrEqual(last.actionsTop + 1);
          await tab.click('[data-to-test-done]');
          expect(await tab.evaluate(() => (window as unknown as { __done: number }).__done)).toBe(1);
          await scrollTo(tab, 0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-run-top.png`) });
        } finally {
          await close();
        }
      });

  for (const { name } of VIEWPORTS)
    for (const theme of ['studio-light', 'neo-dark'] as const)
      it(`opens its snooze menu on screen, mid-scroll (${name}, ${theme})`, async () => {
        const { tab, close } = await open('run', name, theme);
        try {
          await tab.waitForSelector('.fy-totest__actions');
          await framesSettled(tab);
          const first = await scrollBox(tab);
          await scrollTo(tab, (first.scroll - first.client) / 2);
          await tab.click('.fy-totest__actions [data-agenda-snooze]');
          await tab.waitForSelector('.fy-snooze__popover');
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '.fy-snooze__popover'), 'the menu');
          await tab.click('.fy-snooze__popover [role="menuitem"]:last-child');
          await tab.waitForSelector('.fy-snooze__custom');
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '.fy-snooze__popover'), 'the menu with its custom form');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-run-snooze.png`) });
        } finally {
          await close();
        }
      });

  it('prints the title once when the card is titled by its task', async () => {
    const { tab, close } = await open('run', 'phone', 'neo-light', '&same=1');
    try {
      await tab.waitForSelector('.fy-totest__top');
      const shown = await tab.evaluate(() => {
        const head = document.querySelector('.fy-totest__top') as HTMLElement;
        return head.innerText.toLowerCase().split('secret card program check').length - 1;
      });
      expect(shown).toBe(1);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, 'phone-neo-light-run-same-title.png') });
    } finally {
      await close();
    }
  });

  for (const theme of THEMES)
    it(`skips on a swipe down from the title and only scrolls from the steps (phone, ${theme})`, async () => {
      const { tab, context, close } = await open('run', 'phone', theme);
      try {
        await tab.waitForSelector('.fy-totest__top');
        await framesSettled(tab);
        const cdp = await context.newCDPSession(tab);
        const swipe = async (x: number, from: number, to: number): Promise<void> => {
          const touch = (y: number) => [{ x, y }];
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(from) });
          for (let step = 1; step <= 10; step += 1)
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: touch(from + ((to - from) * step) / 10),
            });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await framesSettled(tab);
        };
        const skipped = async (): Promise<number> =>
          await tab.evaluate(() => (window as unknown as { __skipped: number }).__skipped);
        const title = await insideViewport(tab, '[data-to-test-title]');
        const x = title.left + 20;
        // Down from the steps, scrolled a little: the card scrolls back toward its top; nothing is skipped.
        const first = await scrollBox(tab);
        await scrollTo(tab, Math.min(300, first.scroll - first.client));
        const before = (await scrollBox(tab)).top;
        const steps = await insideViewport(tab, '.fy-inbox-step');
        await swipe(steps.left + 40, steps.top + steps.height / 2 - 60, steps.top + steps.height / 2 + 100);
        expect(await skipped(), 'a swipe down in the steps skips nothing').toBe(0);
        expect((await scrollBox(tab)).top, 'it scrolled the card').toBeLessThan(before);
        // Down from the title (the head stays on the box's edge while the card is scrolled): skip.
        const stuck = await insideViewport(tab, '[data-to-test-title]');
        await swipe(x, stuck.top + stuck.height / 2, stuck.top + 260);
        expect(await skipped(), 'a swipe down from the title skips').toBe(1);
      } finally {
        await close();
      }
    });
});

describe('a short Answer-quickly card', () => {
  for (const { name } of VIEWPORTS)
    for (const theme of ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'] as const)
      it(`fills the box, with its answers at the foot (${name}, ${theme})`, async () => {
        const { tab, close } = await open('run', name, theme, '&steps=2');
        try {
          await tab.waitForSelector('.fy-totest__actions');
          await framesSettled(tab);
          const geometry = await tab.evaluate(() => {
            const rect = (query: string) => {
              const element = document.querySelector(query);
              if (element === null) throw new Error(`nothing matches ${query}`);
              const { top, bottom } = element.getBoundingClientRect();
              return { top, bottom };
            };
            const step = document.querySelector('.fy-inbox-step') as HTMLElement;
            const padding = Number.parseFloat(getComputedStyle(step).paddingBottom);
            return {
              box: rect('.fy-inbox-step'),
              card: rect('.fy-totest'),
              actions: rect('.fy-totest__actions'),
              padding,
              overflows: step.scrollHeight > step.clientHeight + 1,
              tabBarTop: rect('[data-tab-bar]').top,
              pageScrolls: (() => {
                const page = document.querySelector('.fy-attn-inbox') as HTMLElement;
                return page.scrollHeight > page.clientHeight + 1;
              })(),
            };
          });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-run-short.png`) });
          expect(
            geometry.tabBarTop - geometry.box.bottom,
            `the box runs down to the tab bar (${JSON.stringify(geometry)})`,
          ).toBeLessThanOrEqual(24);
          expect(geometry.pageScrolls, 'the page does not scroll for it').toBe(false);
          expect(geometry.overflows, `a short card does not scroll (${JSON.stringify(geometry)})`).toBe(false);
          expect(
            Math.abs(geometry.card.bottom - (geometry.box.bottom - geometry.padding)),
            'the card reaches the foot of the box',
          ).toBeLessThanOrEqual(2);
          expect(
            geometry.card.bottom - geometry.actions.bottom,
            'the answers sit at the card foot, not mid-card',
          ).toBeLessThanOrEqual(24);
        } finally {
          await close();
        }
      });
});

describe('option labels that carry Markdown, in the open item', () => {
  for (const { name } of VIEWPORTS)
    for (const theme of THEMES)
      it(`read as plain words, never with literal ** marks (${name}, ${theme})`, async () => {
        const { tab, close } = await open('item', name, theme, '&marked=1');
        try {
          await tab.waitForSelector('[data-agenda-need]');
          await framesSettled(tab);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-option-labels.png`) });
          const shown = await tab.evaluate(() => {
            const text = (query: string) => (document.querySelector(query) as HTMLElement | null)?.innerText ?? '';
            return {
              need: text('[data-agenda-need]'),
              answers: [...document.querySelectorAll<HTMLElement>('[data-agenda-option]')].flatMap(button => [
                button.innerText,
                button.title,
                button.getAttribute('aria-label') ?? '',
              ]),
            };
          });
          expect(shown.need, 'the need box').not.toContain('*');
          expect(shown.need).toContain('Send now');
          expect(shown.need.replaceAll(/\s+/gu, ' '), 'no letter said twice').not.toMatch(/\bA A\b|\bB B\b/u);
          for (const text of shown.answers) expect(text, 'an answer button').not.toContain('*');
        } finally {
          await close();
        }
      });
});
