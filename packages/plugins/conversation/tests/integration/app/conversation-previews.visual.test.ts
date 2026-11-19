/**
 * THE CONVERSATION TAB PREVIEWS in a real browser over fake data (`fixtures/conversation-previews-scene.tsx`): each setting's
 * 160 x 100 frame plays typed → result, holds the result under reduced motion, stops while the tab is hidden, and the chat
 * width strip writes its lines.
 *
 * Set `FY_CONVERSATION_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>-<frame>.png` (1280 and 390, light and dark):
 * every frame at four moments of its loop, plus the whole tab.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONVERSATION_PREVIEWS_SHOTS_DIR ?? '';
const LOOP_MS = 4_200;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-conversation-previews-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/conversation-previews-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the previews scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 900, phone: true },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark', query = '') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  await tab.waitForSelector('[data-setting-preview]');
  return { tab, problems, close: async () => await context.close() };
};

/** Jump every running animation to `ms` into its loop and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

/** typing, the key press, the fade to the result, the settled result. */
const MOMENTS = [
  { name: 'typing', at: 0.12 },
  { name: 'key', at: 0.31 },
  { name: 'fade', at: 0.42 },
  { name: 'result', at: 0.7 },
] as const;

const SCENES = ['editor', 'send-key', 'suggestions', 'chat-width'] as const;

describe('Conversation tab previews', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: every frame is 160 x 100, plays typed then result, and is shot at four moments`, async () => {
        const { tab, problems, close } = await open(viewport, scheme);
        try {
          const frames = tab.locator('[data-setting-preview]');
          expect(await frames.count()).toBe(4);
          for (const box of await frames.evaluateAll(nodes =>
            nodes.map(node => {
              const { width, height } = node.getBoundingClientRect();
              return { width: Math.round(width), height: Math.round(height) };
            }),
          ))
            expect(box).toEqual({ width: 160, height: 100 });
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            'no sideways scroll',
          ).toBeLessThanOrEqual(0);
          for (const moment of MOMENTS) {
            await seek(tab, LOOP_MS * moment.at);
            if (moment.name === 'typing') {
              // The typed words are still being revealed: the first frame's line is clipped, not whole.
              const clip = await tab
                .locator('.fy-cvp-typed')
                .first()
                .evaluate(node => getComputedStyle(node).clipPath);
              expect(clip).not.toBe('none');
            }
            if (moment.name === 'result') {
              const states = await frames.evaluateAll(nodes =>
                nodes.map(node => {
                  const layers = [...node.querySelectorAll('.fy-sp__layer')].map(layer =>
                    Number(getComputedStyle(layer).opacity),
                  );
                  return layers;
                }),
              );
              for (const [before, after] of states) {
                expect(before).toBe(0);
                expect(after).toBe(1);
              }
            }
            if (shotsDir !== '') {
              const count = await frames.count();
              for (let index = 0; index < count; index += 1)
                await frames.nth(index).screenshot({
                  path: join(shotsDir, `${viewport.name}-${scheme}-frame${index + 1}-${moment.name}.png`),
                });
              for (const scene of SCENES)
                await tab.locator(`[data-scene="${scene}"]`).screenshot({
                  path: join(shotsDir, `${viewport.name}-${scheme}-section-${scene}-${moment.name}.png`),
                });
            }
          }
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: choosing another value replays that frame from its start`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          const suggestions = tab.locator('[data-scene="suggestions"] [data-setting-preview]');
          expect(await suggestions.getAttribute('data-sp-value')).toBe('ladder-skills');
          await tab.locator('[data-scene="suggestions"] input[value="symbols"]').check({ force: true });
          await tab.waitForFunction(
            () =>
              document
                .querySelector('[data-scene="suggestions"] [data-setting-preview]')
                ?.getAttribute('data-sp-value') === 'symbols-skills',
          );
          expect(await suggestions.locator('.fy-cvp-typed').first().textContent()).toBe(':');
          await tab.locator('[data-scene="send-key"]').getByText('⌘/Ctrl+↵ sends').click();
          expect(
            await tab.locator('[data-scene="send-key"] [data-setting-preview]').first().getAttribute('data-sp-label'),
          ).toBe('The key starts a new line');
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: with motion reduced every frame holds its result and nothing runs`, async () => {
        const { tab, close } = await open(viewport, scheme, '&motion=reduced');
        try {
          const states = await tab
            .locator('[data-setting-preview]')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sp-state')));
          expect(states).toEqual(['still', 'still', 'still', 'still']);
          expect(await tab.locator('.fy-sp__layer--before').count()).toBe(0);
          expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
          expect(await tab.locator('[data-cvp-motion="still"]').count()).toBe(1);
          if (shotsDir !== '')
            for (const scene of SCENES)
              await tab
                .locator(`[data-scene="${scene}"]`)
                .screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-section-${scene}-reduced.png`) });
        } finally {
          await close();
        }
      });
    }

  it('the chat width strip writes its lines while motion is on and stops while the tab is hidden', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'light');
    try {
      const writing = await tab
        .locator('.fy-cvp-write')
        .first()
        .evaluate(node => getComputedStyle(node).animationName);
      expect(writing).toBe('fy-cvp-write');
      await tab.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-setting-preview]')?.getAttribute('data-sp-state') === 'paused',
      );
      const states = await tab
        .locator('[data-setting-preview] *')
        .evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(animation => animation.playState)));
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state === 'paused')).toBe(true);
    } finally {
      await close();
    }
  });
});
