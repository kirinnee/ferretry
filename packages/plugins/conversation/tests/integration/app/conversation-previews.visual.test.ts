/**
 * THE CONVERSATION TAB PREVIEWS in a real browser over fake data (`fixtures/conversation-previews-scene.tsx`): each setting's
 * 160 x 100 frame plays typed → result, holds the result under reduced motion, stops while the tab is hidden, and the chat
 * width strip writes its lines.
 *
 * Set `FY_CONVERSATION_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>-<frame>.png` (1280 and 390, light and dark):
 * every frame at eight moments of its loop (typing, the key press, the fade out, the fade in, the result arriving, the
 * settled result, the Agents → Skills hand-over, and the Skills menu), plus the whole tab.
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
const LOOP_MS = 1_400;

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
  // `&rest=1` opens the page as it is drawn, with nothing changed, for the strip that runs on its own.
  if (!query.includes('rest=1')) await nudge(tab);
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

/**
 * The frames REST on the chosen value and play once when it changes (compose/setting-preview), so each choice is given
 * one change and the way back, and every movement is then held at its start so a frame is the same on every run.
 */
const nudge = async (tab: Page): Promise<void> => {
  // A change and then the way back: every choice ends on the value it started on, having played one movement.
  const names = await tab.evaluate(() => [
    ...new Set([...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.name)),
  ]);
  for (const name of names) {
    const radios = tab.locator(`input[type="radio"][name="${name}"]`);
    const homeValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => n.checked)?.value ?? null,
    );
    const awayValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => !n.checked && !n.disabled)?.value ?? null,
    );
    if (homeValue === null || awayValue === null) continue;
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${awayValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${homeValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
  const switches = tab.locator('[role="switch"], button[aria-pressed]');
  for (let index = 0; index < (await switches.count()); index += 1) {
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
};

/**
 * The loop's moments, against the take-turns crossfade (before visible 0-36%, gone by 42%; after fades in 48-54%, in
 * 54-88%): typing, the key press, the typing layer fading out, the result layer fading in, the result arriving, the
 * settled result (the Agents menu fully open), the Agents menu handing over to the Skills menu, and the Skills menu.
 */
const MOMENTS = [
  { name: 'typing', at: 0.12 },
  { name: 'key', at: 0.3 },
  { name: 'fade', at: 0.42 },
  { name: 'fadein', at: 0.51 },
  { name: 'arrive', at: 0.56 },
  { name: 'result', at: 0.63 },
  { name: 'swap', at: 0.73 },
  { name: 'late', at: 0.84 },
] as const;

const SCENES = ['editor', 'send-key', 'suggestions', 'chat-width'] as const;

describe('Conversation tab previews', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: every frame is 160 x 100, plays typed then result, and is shot at eight moments`, async () => {
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
              for (const layers of states) {
                // A frame that has not changed rests: its one layer is the result. One that has played shows before gone.
                expect(layers.at(-1)).toBe(1);
                if (layers.length === 2) expect(layers[0]).toBe(0);
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

      it(`${viewport.name} ${scheme}: the motion that shows each setting happens while its layer is visible`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          const opacityOf = async (selector: string): Promise<number> =>
            Number(
              await tab
                .locator(selector)
                .first()
                .evaluate(node => getComputedStyle(node).opacity),
            );
          const travelOf = async (selector: string): Promise<number> =>
            await tab
              .locator(selector)
              .first()
              .evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42);
          const clipOf = async (selector: string): Promise<string> =>
            await tab
              .locator(selector)
              .first()
              .evaluate(node => getComputedStyle(node).clipPath);
          const send = '[data-scene="send-key"] [data-setting-preview]';
          const suggestions = '[data-scene="suggestions"] [data-setting-preview]';
          // Send key (Enter sends): the key goes down while the typing layer is fully visible...
          await seek(tab, LOOP_MS * 0.27);
          expect(await opacityOf(`${send} .fy-sp__layer--before`)).toBe(1);
          expect(
            await tab
              .locator(`${send} .fy-cvp-key--press`)
              .first()
              .evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a),
          ).toBeLessThan(1);
          // ...and the bubble is still travelling up (several px) once the result layer is fully in.
          await seek(tab, LOOP_MS * 0.56);
          expect(await opacityOf(`${send} .fy-sp__layer--after`)).toBe(1);
          expect(await travelOf(`${send} .fy-cvp-bubble`)).toBeGreaterThan(5);
          await seek(tab, LOOP_MS * 0.8);
          expect(await travelOf(`${send} .fy-cvp-bubble`)).toBe(0);
          // Suggestions: the Agents menu is mid pop-in with its layer fully visible...
          await seek(tab, LOOP_MS * 0.545);
          expect(await opacityOf(`${suggestions} .fy-sp__layer--after`)).toBe(1);
          const popping = await opacityOf(`${suggestions} .fy-cvp-pop--agents`);
          expect(popping).toBeGreaterThan(0.05);
          expect(popping).toBeLessThan(0.95);
          // ...then settled, while the Skills menu is its own menu that has not opened yet...
          await seek(tab, LOOP_MS * 0.63);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--agents`)).toBe(1);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--skills`)).toBe(0);
          // ...and the Agents menu closes as the `$` is typed and the Skills menu opens in its place.
          await seek(tab, LOOP_MS * 0.84);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--agents`)).toBe(0);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--skills`)).toBe(1);
          expect(await clipOf(`${suggestions} .fy-cvp-typed--skill`)).not.toContain('100%');
          // Enter starts a new line: the second line types while the result layer is visible.
          await tab.locator('[data-scene="send-key"]').getByText('⌘/Ctrl+↵ sends').click();
          await seek(tab, LOOP_MS * 0.66);
          expect(await opacityOf(`${send} .fy-sp__layer--after`)).toBe(1);
          const typing = await clipOf(`${send} .fy-cvp-typed--late`);
          expect(typing).not.toBe('none');
          expect(typing).not.toBe('inset(0px 100% 0px 0px)');
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
          expect(await tab.locator('[data-scene="suggestions"] .fy-cvp-pop-title').allTextContents()).toEqual([
            'Agents',
            'Skills',
          ]);
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
    const { tab, close } = await open(VIEWPORTS[0], 'light', '&rest=1');
    try {
      const writing = await tab
        .locator('.fy-cvp-write')
        .first()
        .evaluate(node => getComputedStyle(node).animationName);
      expect(writing).toBe('fy-cvp-write');
      // It is the last section: bring it into view, so only the hidden tab (not the scroll) can pause it.
      await tab.locator('[data-cvp-motion]').scrollIntoViewIfNeeded();
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'on',
      );
      await tab.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // (The preview frames rest until a value changes, so only the strip runs here; the frames' own pause is in
      // the app's setting-preview browser test.)
      // The chat width strip goes through the same pause path: its lines stop writing too.
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'paused',
      );
      const held = await tab
        .locator('.fy-cvp-write')
        .evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(animation => animation.playState)));
      expect(held.length).toBe(3);
      expect(held.every(state => state === 'paused')).toBe(true);
      await tab.evaluate(() => {
        Reflect.deleteProperty(document, 'visibilityState');
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'on',
      );
      expect(
        await tab
          .locator('.fy-cvp-write')
          .evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(animation => animation.playState))),
      ).toEqual(['running', 'running', 'running']);
    } finally {
      await close();
    }
  });

  it('the chat width strip stops writing while it is scrolled off-screen and resumes when it is back in view', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'light');
    try {
      const motion = () =>
        tab.evaluate(() => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion'));
      await tab.setViewportSize({ width: 1_280, height: 300 });
      await tab.evaluate(() => window.scrollTo(0, 0));
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'paused',
      );
      expect(await motion()).toBe('paused');
      expect(
        await tab
          .locator('.fy-cvp-write')
          .evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(animation => animation.playState))),
      ).toEqual(['paused', 'paused', 'paused']);
      await tab.locator('[data-cvp-motion]').scrollIntoViewIfNeeded();
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'on',
      );
      expect(await motion()).toBe('on');
    } finally {
      await close();
    }
  });
});
