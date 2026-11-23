/**
 * THE CONVERSATION TAB PREVIEWS in a real browser over fake data (`fixtures/conversation-previews-scene.tsx`): each setting's
 * 160 x 100 frame plays typed → result, holds the result under reduced motion, stops while the tab is hidden, and the chat
 * width strip writes its lines.
 *
 * Each frame RESTS on the chosen value and plays ONCE when a value is chosen (never a loop), inside the Settings shell's own
 * frame. Most tests freeze the page's clock (Playwright `clock.pauseAt`) so the play's ending timer cannot fire while a moment
 * is held; the "real play" tests run on real time and check the frame is never empty, then rests beyond two play lengths.
 *
 * Set `FY_CONVERSATION_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>-<frame>.png` (1280 and 390, light and dark):
 * every frame at eight moments of its play (typing, the key press, the fade in, the result arriving, the settled result,
 * the Agents → Skills hand-over, the Skills menu, and the rested end), plus the whole tab.
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

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
  query = '',
  /** Freeze the page's clock after load so a play's ending timer never fires while a moment is held. */
  frozen = true,
) => {
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
  if (frozen) await tab.clock.install();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  await tab.waitForSelector('[data-setting-preview]');
  if (frozen) await tab.clock.pauseAt(new Date(Date.now() + 60_000));
  // `&rest=1` opens the page as it is drawn, with nothing chosen, so every frame rests.
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
 * The play's moments, against the cross-fade (the typing layer stays fully opaque until 54%, the result layer fades in
 * from 18% and is fully in from 54%): typing, the key press, the result arriving, the Agents menu popping open, the settled
 * result, the Agents → Skills hand-over, the Skills menu, and the end of the play (where the frame rests).
 */
const MOMENTS = [
  { name: 'typing', at: 0.12 },
  { name: 'key', at: 0.3 },
  { name: 'fadein', at: 0.4 },
  { name: 'arrive', at: 0.5 },
  { name: 'result', at: 0.6 },
  { name: 'swap', at: 0.69 },
  { name: 'late', at: 0.84 },
  { name: 'end', at: 0.99 },
] as const;

const SCENES = ['editor', 'send-key', 'suggestions', 'chat-width'] as const;

describe('Conversation tab previews', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: every frame is 160 x 100, plays typed then result once, and is shot at eight moments`, async () => {
        const { tab, problems, close } = await open(viewport, scheme);
        try {
          const frames = tab.locator('[data-setting-preview]');
          expect(await frames.count()).toBe(3);
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
          await seek(tab, LOOP_MS * 0.3);
          expect(await opacityOf(`${send} .fy-sp__layer--before`)).toBe(1);
          expect(
            await tab
              .locator(`${send} .fy-cvp-key--press`)
              .first()
              .evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a),
          ).toBeLessThan(1);
          // ...and the bubble is still travelling up (several px) once the result layer is fully in, then rests.
          await seek(tab, LOOP_MS * 0.56);
          expect(await opacityOf(`${send} .fy-sp__layer--after`)).toBe(1);
          expect(await travelOf(`${send} .fy-cvp-bubble`)).toBeGreaterThan(2);
          await seek(tab, LOOP_MS * 0.85);
          expect(await travelOf(`${send} .fy-cvp-bubble`)).toBe(0);
          // Suggestions: the Agents menu is mid pop-in with its layer arriving over the typing...
          await seek(tab, LOOP_MS * 0.46);
          expect(await opacityOf(`${suggestions} .fy-sp__layer--after`)).toBeGreaterThan(0.5);
          const popping = await opacityOf(`${suggestions} .fy-cvp-pop--agents`);
          expect(popping).toBeGreaterThan(0.05);
          expect(popping).toBeLessThan(0.95);
          // ...then settled, while the Skills menu is its own menu that has not opened yet...
          await seek(tab, LOOP_MS * 0.62);
          expect(await opacityOf(`${suggestions} .fy-sp__layer--after`)).toBe(1);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--agents`)).toBe(1);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--skills`)).toBe(0);
          // ...and the Agents menu closes as the `$` is typed and the Skills menu opens in its place, where it rests.
          await seek(tab, LOOP_MS * 0.99);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--agents`)).toBe(0);
          expect(await opacityOf(`${suggestions} .fy-cvp-pop--skills`)).toBe(1);
          expect(await clipOf(`${suggestions} .fy-cvp-typed--skill`)).not.toContain('100%');
          // Enter starts a new line: the second line types while the result layer is visible.
          await tab.locator('[data-scene="send-key"]').getByText('⌘/Ctrl+↵ sends').click();
          await seek(tab, LOOP_MS * 0.7);
          expect(await opacityOf(`${send} .fy-sp__layer--after`)).toBe(1);
          const typing = await clipOf(`${send} .fy-cvp-typed--late`);
          expect(typing).not.toBe('none');
          expect(typing).not.toBe('inset(0px 100% 0px 0px)');
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: the suggestion cards (P1's ChoiceCards) sit in one row at desktop width, stay under 64px on a phone, and the (i) ends the line`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          const boxes = await tab
            .locator('[data-scene="suggestions"] .fy-cc__card')
            .evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON() as DOMRect));
          expect(boxes.length).toBe(3);
          expect(await tab.locator('[data-scene="suggestions"] .fy-cc-card').count(), 'the stand-in is gone').toBe(0);
          const group = (await tab.locator('[data-scene="suggestions"] .fy-cc__grid').boundingBox())?.width ?? 0;
          // The content column of the Settings shell at 1280 is about 714px wide (the owner's screenshot).
          if (!viewport.phone) {
            const page = (await tab.locator('.fy-settings-page').boundingBox())?.width ?? 0;
            expect(page).toBeGreaterThan(700);
            for (const box of boxes) expect(box.width).toBeLessThanOrEqual(320);
            expect(new Set(boxes.map(box => Math.round(box.top))).size, '3 cards in ONE row').toBe(1);
            expect(boxes[2]!.right - boxes[0]!.left).toBeLessThanOrEqual(group + 1);
          } else {
            // Below 480px of the group's own width the cards stack, and stay short.
            for (const box of boxes) expect(box.height).toBeLessThan(64);
            expect(new Set(boxes.map(box => Math.round(box.top))).size).toBe(3);
          }
          // The keys are a mono line, and the shell's `.fy-page label` rule did not turn a card into a block.
          const card = tab.locator('[data-scene="suggestions"] .fy-cc__card').first();
          expect(await card.evaluate(node => getComputedStyle(node).display)).toBe('flex');
          expect(await card.locator('.fy-cc__line').evaluate(node => getComputedStyle(node).fontFamily)).toMatch(
            /mono|monospace/i,
          );
          const text = await tab.locator('[data-suggestions-detail]').boundingBox();
          const info = await tab.locator('[data-suggestions-detail] button').boundingBox();
          // The (i) sits on the last line of the sentence, not under it.
          expect((info?.y ?? 0) + (info?.height ?? 0)).toBeLessThanOrEqual((text?.y ?? 0) + (text?.height ?? 0) + 1);
          expect(info?.y).toBeGreaterThanOrEqual((text?.y ?? 0) - 1);
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
          expect(states).toEqual(['still', 'still', 'still']);
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

  it('the suggestions frame plays once on a choice, then rests beyond two play lengths with nothing running', async () => {
    // Real time, nothing frozen or seeked: this is the owner's shot 02 (select once; the scene must not loop).
    const { tab, close } = await open(VIEWPORTS[0], 'light', '&rest=1', false);
    try {
      const frame = tab.locator('[data-scene="suggestions"] [data-setting-preview]');
      expect(await frame.getAttribute('data-sp-state')).toBe('still');
      expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
      await tab.locator('[data-scene="suggestions"] input[value="symbols"]').check({ force: true });
      expect(await frame.getAttribute('data-sp-state')).toBe('playing');
      // Visible content throughout: at every sample one layer is opaque, so the frame is never empty.
      const lowest: number[] = [];
      const started = Date.now();
      while (Date.now() - started < LOOP_MS * 2 + 400) {
        lowest.push(
          await frame.evaluate(node => {
            const opacity = (kind: string): number => {
              const layer = node.querySelector(`.fy-sp__layer--${kind}`);
              return layer === null ? 0 : Number(getComputedStyle(layer).opacity);
            };
            return 1 - (1 - opacity('before')) * (1 - opacity('after'));
          }),
        );
      }
      expect(Math.min(...lowest)).toBe(1);
      // Beyond two preview durations: at rest, on the chosen value, and nothing in it is animating.
      expect(await frame.getAttribute('data-sp-state')).toBe('still');
      expect(await frame.getAttribute('data-sp-value')).toBe('symbols-skills');
      expect(await frame.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
      expect(
        await tab.evaluate(
          () => document.getAnimations().filter(animation => animation.playState === 'running').length,
        ),
        'nothing on the page is running',
      ).toBe(0);
      expect(await frame.locator('.fy-cvp-pop--agents, .fy-cvp-pop--skills').count()).toBeGreaterThan(0);
      expect(
        await frame.locator('.fy-cvp-pop--skills').evaluate(node => Number(getComputedStyle(node).opacity)),
        'the rested frame shows the Skills menu',
      ).toBe(1);
    } finally {
      await close();
    }
  });

  it('the chat width strip rests until a width is chosen, writes its lines once, holds while hidden, then rests written', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'light', '&rest=1', false);
    try {
      const strip = tab.locator('[data-cvp-motion]');
      const writes = tab.locator('.fy-cvp-write');
      await strip.scrollIntoViewIfNeeded();
      expect(await strip.getAttribute('data-cvp-write')).toBe('rest');
      expect(await writes.evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().length))).toEqual([0, 0, 0]);
      await tab.locator('[data-scene="chat-width"] input[value="readable"]').locator('xpath=ancestor::label').click();
      expect(await strip.getAttribute('data-cvp-write')).toBe('play');
      expect(await writes.first().evaluate(node => getComputedStyle(node).animationName)).toBe('fy-cvp-write');
      expect(await writes.first().evaluate(node => getComputedStyle(node).animationIterationCount)).toBe('1');
      await tab.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'paused',
      );
      expect(
        await writes.evaluateAll(nodes =>
          nodes.flatMap(node => node.getAnimations().map(animation => animation.playState)),
        ),
      ).toEqual(['paused', 'paused', 'paused']);
      await tab.evaluate(() => {
        Reflect.deleteProperty(document, 'visibilityState');
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'on',
      );
      // The play ends (1.4 s, the last line delayed 320 ms) and the lines are written. The end is waited FOR, not timed: a
      // loaded runner paints late, and the page's animation clock then runs behind the wall clock (CI saw all three lines
      // still running after a fixed wait of two plays). A play that never ends fails this wait.
      await tab.waitForFunction(
        () => [...document.querySelectorAll('.fy-cvp-write')].every(node => node.getAnimations().length === 0),
        undefined,
        { timeout: 30_000 },
      );
      // …and it rests: a whole further play and a half later nothing has started again (it writes once, it does not loop).
      await tab.waitForTimeout(LOOP_MS * 1.5);
      expect(await writes.evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().length))).toEqual([0, 0, 0]);
      expect(
        await writes.evaluateAll(nodes => nodes.map(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a)),
      ).toEqual([1, 1, 1]);
    } finally {
      await close();
    }
  });

  it('the chat width strip holds its play while it is scrolled off-screen and resumes when it is back in view', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'light', '&rest=1');
    try {
      const motion = () =>
        tab.evaluate(() => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion'));
      await tab.setViewportSize({ width: 1_280, height: 300 });
      await tab.evaluate(() => window.scrollTo(0, 0));
      await tab.waitForFunction(
        () => document.querySelector('[data-cvp-motion]')?.getAttribute('data-cvp-motion') === 'paused',
      );
      expect(await motion()).toBe('paused');
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
