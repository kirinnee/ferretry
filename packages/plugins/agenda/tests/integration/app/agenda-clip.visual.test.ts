/** The unified agenda item keeps menus in the viewport and renders marked option labels. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CLIP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-clip-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-clip-scene.tsx'],
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

describe('the snooze choices in the open item’s ⋯ menu', () => {
  for (const { name } of VIEWPORTS)
    for (const theme of THEMES)
      it(`opens with every edge on screen (${name}, ${theme})`, async () => {
        const { tab, close } = await open('item', name, theme);
        try {
          // A sheet on a phone, a popover wider: either is the menu (`data-agenda-menu`).
          await tab.click('.fy-item-view__bar [data-agenda-menu-toggle]');
          await tab.waitForSelector('[data-agenda-menu] [data-agenda-menu-snooze]');
          await tab.waitForTimeout(250);
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '[data-agenda-menu]'), 'the menu');
          await tab.click('[data-agenda-menu] [data-agenda-menu-snooze="custom"]');
          await tab.waitForSelector('[data-agenda-menu] .fy-snooze__custom');
          await framesSettled(tab);
          expectOnScreen(await insideViewport(tab, '[data-agenda-menu]'), 'the menu with its custom form');
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
