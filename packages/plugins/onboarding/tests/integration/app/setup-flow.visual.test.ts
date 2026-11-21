/**
 * THE SETUP FLOW (`fixtures/setup-flow-scene.tsx`) in a real browser on a phone and a desktop, light and dark, over fake
 * data: the loading cover, a choice page, the "Only on" chip, a busy page, a frame mid slide-in and the end page. Set
 * `FY_SETUP_FLOW_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETUP_FLOW_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setup-flow-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/setup-flow-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  browser = await sharedChromium();
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
const CASES = [
  'loading',
  'silent',
  'choice',
  'chip',
  'busy',
  'transition',
  'end',
  'legacy',
  'unsaved',
  'end-unsaved',
] as const;

describe('the setup flow', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws every page state without sideways scroll, the footer in view and buttons that are not full width (${viewport.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          for (const scene of CASES) {
            await tab.goto(`${origin}/?theme=studio-${scheme}&case=${scene}`);
            await tab.waitForSelector('[data-scene-ready]');
            if (scene === 'silent') {
              await tab.waitForSelector('[data-flow-silent]');
              // The loader fades in after a beat (no flash for a fast answer): shoot it settled.
              await tab.waitForTimeout(900);
            } else await tab.waitForTimeout(scene === 'transition' ? 50 : 300);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, `${scene}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
            // The cover and the page never show together.
            const covered = (await tab.$$('[data-flow-cover]')).length;
            const slot = await tab.$('.fy-sf-slot');
            const slotShown = slot === null ? false : await slot.isVisible();
            expect(covered > 0 && slotShown, `${scene}: the cover and the page never show together`).toBe(false);
            expect(covered > 0, `${scene}: the cover is up exactly while the page has not said ready`).toBe(
              scene === 'loading' || scene === 'silent',
            );
            // The footer is in the viewport, and no footer button is anywhere near full width.
            const footer = await tab.$('[data-step-footer]');
            expect(footer, `${scene}: a footer`).not.toBeNull();
            const box = await footer?.boundingBox();
            expect(
              box === null || box === undefined ? 0 : box.y + box.height,
              `${scene}: the footer is on screen`,
            ).toBeLessThanOrEqual(viewport.height + 1);
            const widths = await tab.$$eval('[data-step-footer] button', buttons =>
              buttons.map(button => ({
                w: button.getBoundingClientRect().width,
                h: button.getBoundingClientRect().height,
              })),
            );
            for (const size of widths) {
              expect(size.w, `${scene}: a footer button is not full width`).toBeLessThan(
                (viewport.phone ? 0.7 : 0.5) * viewport.width,
              );
              expect(size.h, `${scene}: a footer button is at least 44px tall`).toBeGreaterThanOrEqual(43.5);
            }
            if (scene === 'silent') {
              expect(await tab.$$('[data-flow-skip]')).toHaveLength(1);
              const skip = await (await tab.$('[data-flow-skip]'))?.boundingBox();
              expect(skip?.height ?? 0, 'Skip this step is a 44px target').toBeGreaterThanOrEqual(43.5);
              expect(
                await tab.$$('[data-flow-cover] [data-loading]'),
                'the spinner is drawn with the note',
              ).toHaveLength(1);
            }
            if (scene === 'choice') {
              const later = await (await tab.$('[data-flow-later]'))?.boundingBox();
              expect(later?.height ?? 0, 'Later is a 44px target').toBeGreaterThanOrEqual(43.5);
            }
            if (scene === 'chip') expect(await tab.textContent('[data-only-on]')).toBe('Only on studio-box');
            if (scene === 'busy') {
              expect(await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled)).toBe(true);
              expect(await tab.$eval('[data-step-back]', back => (back as HTMLButtonElement).disabled)).toBe(true);
              expect(await tab.$eval('[data-flow-later]', later => (later as HTMLButtonElement).disabled)).toBe(true);
            }
            if (scene === 'legacy') {
              expect(await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled)).toBe(false);
              expect(await tab.$('[data-flow-cover]'), 'a legacy page has no cover').toBeNull();
            }
            if (scene === 'unsaved' || scene === 'end-unsaved') {
              expect(await tab.$('[data-flow-unsaved]'), `${scene}: says an answer was not saved`).not.toBeNull();
              const retries = await tab.$$eval('[data-flow-retry-save]', buttons =>
                buttons.map(button => button.getBoundingClientRect().height),
              );
              expect(retries.length, `${scene}: a Try again`).toBeGreaterThan(0);
              for (const height of retries)
                expect(height, `${scene}: Try again is a 44px target`).toBeGreaterThanOrEqual(43.5);
            }
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${scene}.png`), fullPage: true });
          }
        } finally {
          await context.close();
        }
      });
});

// ─── the page frame in the shell's scroll box (r10-1 gate gap 4 and the phone line) ─────────────────────────────────────
// A page a little under one screen and one far over it, scrolled by the shell's own box: on a desktop the footer (Back / Next)
// is on the first screen with no dead gap under the title, and on a phone the last thing on the page ends above the footer.
describe('the page frame in the shell scroll box', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const scene of ['mid', 'tall'] as const)
        it(`keeps Next on the first screen and nothing under the footer (${scene}, ${viewport.name}, ${scheme})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          try {
            await tab.goto(`${origin}/?theme=studio-${scheme}&case=${scene}`);
            await tab.waitForSelector('[data-scene-ready] [data-last-content]');
            await tab.waitForTimeout(300);
            const read = () =>
              tab.evaluate(() => {
                const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
                const main = document.querySelector('[data-scene-main]') as HTMLElement;
                const title = rect('.fy-spf__title');
                const first = rect('.fy-sf-slot > div > div');
                return {
                  innerHeight: window.innerHeight,
                  scrolls: main.scrollHeight > main.clientHeight,
                  next: rect('[data-step-next]'),
                  footer: rect('[data-step-footer]'),
                  last: rect('[data-last-content]'),
                  gap: title === undefined || first === undefined ? -1 : first.top - title.bottom,
                  docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                };
              });
            // First screen, nothing scrolled: Next is inside the viewport whatever the page's height, and the title sits
            // right over the page (the dead gap under it is gone).
            const top = await read();
            expect(top.next, `${scene}: a Next button`).toBeDefined();
            expect(top.next?.top ?? -1, `${scene}: Next starts inside the viewport`).toBeGreaterThanOrEqual(0);
            expect(top.next?.bottom ?? 1e9, `${scene}: Next ends inside the viewport`).toBeLessThanOrEqual(
              top.innerHeight + 0.5,
            );
            expect(top.gap, `${scene}: the page starts under its title`).toBeGreaterThanOrEqual(0);
            expect(top.gap, `${scene}: no dead gap under the title`).toBeLessThanOrEqual(40);
            expect(top.docOverflow, `${scene}: no sideways scroll`).toBeLessThanOrEqual(0);
            if (scene === 'tall') expect(top.scrolls, 'tall: the shell box scrolls').toBe(true);
            // Scrolled to the end: the last thing on the page ends above the footer (nothing hides under it).
            await tab.evaluate(() => {
              const main = document.querySelector('[data-scene-main]') as HTMLElement;
              main.scrollTop = main.scrollHeight;
            });
            await tab.waitForTimeout(150);
            const end = await read();
            expect(end.last?.bottom ?? 1e9, `${scene}: the last content ends above the footer`).toBeLessThanOrEqual(
              (end.footer?.top ?? 0) + 0.5,
            );
            expect(end.next?.bottom ?? 1e9, `${scene}: Next is still on screen at the end`).toBeLessThanOrEqual(
              end.innerHeight + 0.5,
            );
            if (shotsDir !== '') {
              await tab.evaluate(() => {
                (document.querySelector('[data-scene-main]') as HTMLElement).scrollTop = 0;
              });
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${scene}-top.png`) });
              await tab.evaluate(() => {
                const main = document.querySelector('[data-scene-main]') as HTMLElement;
                main.scrollTop = main.scrollHeight;
              });
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${scene}-end.png`) });
            }
          } finally {
            await context.close();
          }
        });
});

// ─── r11 O1: Next saves the choice, and the loading cover waits 300 ms (owner items 4 and 5) ────────────────────────────
// The proof of the owner's lines is in the browser, on the real `FlowPage`: (a) a page that registers `commit` is saved by
// Next, once, and only then does the next page come up; a save that rejects keeps the page, says why, and runs again on the
// next press; (b) a page that answers inside 300 ms never has a loader drawn (sampled every frame, opacity AND size), and one
// that answers later has it from 300 ms on.
const LOADER_SAMPLER = `
  window.__loader = { first: -1, last: -1, frames: 0 };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= 0.01) return false;
    }
    return true;
  };
  const tick = () => {
    const now = performance.now();
    const hit = [...document.querySelectorAll('[data-loading], .fy-spinner')].some(visible);
    if (hit) {
      if (window.__loader.first < 0) window.__loader.first = now;
      window.__loader.last = now;
      window.__loader.frames += 1;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
`;

describe('r11 O1: Next saves the choice and the loader waits 300 ms', () => {
  const open = async (scheme: 'light' | 'dark', width: number, height: number) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    return { context, origin, tab: await context.newPage() };
  };
  const title = (tab: import('playwright-core').Page) => tab.textContent('.fy-spf__title');
  const saves = (tab: import('playwright-core').Page) =>
    tab.evaluate(() => (window as unknown as { __saves?: number }).__saves ?? 0);

  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`Next runs the registered save once, then shows the next page (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=commit`);
          await tab.waitForSelector('[data-flow-page="fake-pack.choose"]:not([hidden])');
          expect(await saves(tab), 'nothing is saved before Next').toBe(0);
          await tab.click('[data-step-next]');
          await tab.waitForFunction(() => document.querySelector('.fy-spf__title')?.textContent === 'Second page');
          expect(await saves(tab), 'the save ran exactly once').toBe(1);
          await tab.waitForTimeout(200);
          expect(await saves(tab), 'and not again').toBe(1);
        } finally {
          await context.close();
        }
      });
      it(`a rejected save keeps the page, shows the message and runs again on the next Next (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=commit-fail`);
          await tab.waitForSelector('[data-flow-page="fake-pack.choose"]:not([hidden])');
          await tab.click('[data-step-next]');
          await tab.waitForSelector('[data-flow-commit-error]');
          expect(await tab.textContent('[data-flow-commit-error]')).toContain('Could not reach the machine.');
          expect(await title(tab), 'still on the same page').toBe('How should it import?');
          expect(await saves(tab)).toBe(1);
          // Let Next's fade back from its locked look finish before shooting.
          await tab.waitForTimeout(400);
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `${viewport.name}-${scheme}-commit-failed.png`),
              fullPage: true,
            });
          expect(
            await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled),
            'Next is enabled to try again',
          ).toBe(false);
          await tab.click('[data-step-next]');
          await tab.waitForFunction(() => document.querySelector('.fy-spf__title')?.textContent === 'Second page');
          expect(await saves(tab), 'the save ran again on the second Next').toBe(2);
          expect(await tab.$('[data-flow-commit-error]'), 'the message is gone with the page').toBeNull();
        } finally {
          await context.close();
        }
      });
    }

  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`while the save is pending the first page stays with Next locked; releasing it moves on (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=commit-gated`);
          await tab.waitForSelector('[data-flow-page="fake-pack.choose"]:not([hidden])');
          await tab.click('[data-step-next]');
          await tab.waitForFunction(
            () => (window as unknown as { __releaseSave?: () => void }).__releaseSave !== undefined,
          );
          await tab.waitForTimeout(250);
          expect(await title(tab), 'still on the first page while the save is pending').toBe('How should it import?');
          expect(
            await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled),
            'Next is disabled while the save is pending',
          ).toBe(true);
          expect(await tab.textContent('[data-flow-busy]')).toBe('Saving…');
          expect(await saves(tab), 'one save in flight').toBe(1);
          await tab.evaluate(() => (window as unknown as { __releaseSave: () => void }).__releaseSave());
          await tab.waitForFunction(() => document.querySelector('.fy-spf__title')?.textContent === 'Second page');
          expect(await saves(tab), 'still one save').toBe(1);
        } finally {
          await context.close();
        }
      });
      it(`a save that throws while it is being prepared is handled like a rejection: message, Next enabled, retry works (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          const uncaught: string[] = [];
          tab.on('pageerror', error => uncaught.push(error.message));
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=commit-throw`);
          await tab.waitForSelector('[data-flow-page="fake-pack.choose"]:not([hidden])');
          await tab.click('[data-step-next]');
          await tab.waitForTimeout(400);
          expect(uncaught, 'no uncaught error').toEqual([]);
          expect(await tab.textContent('[data-flow-commit-error]'), 'the message is shown').toContain(
            'Could not prepare the request.',
          );
          expect(await tab.$('[data-flow-busy]'), 'Saving… is cleared').toBeNull();
          expect(
            await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled),
            'Next is enabled to try again',
          ).toBe(false);
          await tab.click('[data-step-next]');
          await tab.waitForFunction(() => document.querySelector('.fy-spf__title')?.textContent === 'Second page');
          expect(await saves(tab), 'the retry ran the save again').toBe(2);
        } finally {
          await context.close();
        }
      });
    }

  for (const scheme of ['light', 'dark'] as const) {
    it(`a failed save on a tall page shows its message on screen, in the footer, at 390 (${scheme})`, async () => {
      const { context, origin, tab } = await open(scheme, 390, 844);
      try {
        await tab.goto(`${origin}/?theme=studio-${scheme}&case=commit-tall`);
        await tab.waitForSelector('[data-flow-page="fake-pack.choose"]:not([hidden])');
        await tab.click('[data-step-next]');
        await tab.waitForSelector('[data-flow-commit-error]');
        await tab.waitForTimeout(200);
        const box = await tab.$eval('[data-flow-commit-error]', el => {
          const r = el.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            inFooter: el.closest('[data-step-footer]') !== null,
          };
        });
        const next = await tab.$eval('[data-step-next]', el => el.getBoundingClientRect().top);
        console.info(
          `failed save on a tall page (${scheme}): message y ${box.top.toFixed(0)}–${box.bottom.toFixed(0)}, Next top ${next.toFixed(0)}, viewport 844`,
        );
        expect(box.inFooter, 'the message is in the footer').toBe(true);
        expect(box.top, 'the message starts on screen').toBeGreaterThanOrEqual(0);
        expect(box.bottom, 'the message ends on screen').toBeLessThanOrEqual(844);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(390);
        expect(box.bottom, 'the message sits above Next').toBeLessThanOrEqual(next + 1);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `390-${scheme}-commit-failed-tall.png`) });
      } finally {
        await context.close();
      }
    });
  }

  it("the flow's machine-discovery cover keeps the loader's own threshold, the step cover waits in its own code", async () => {
    const { context, origin, tab } = await open('light', 1_280, 800);
    try {
      await tab.goto(`${origin}/?theme=studio-light&case=discovery`);
      await tab.waitForSelector('[data-flow-loading] .fy-loading--page');
      const delay = await tab.$eval('[data-flow-loading] .fy-loading--page', el => getComputedStyle(el).animationDelay);
      console.info(`discovery cover loader animation-delay: ${delay}`);
      expect(delay, 'the machine-discovery loader keeps its threshold (not reset to 0s)').not.toBe('0s');
      const ms = Number.parseFloat(delay) * 1_000;
      expect(ms, 'a real, non-zero threshold').toBeGreaterThanOrEqual(150);
      await tab.goto(`${origin}/?theme=studio-light&case=late&ms=900`);
      await tab.waitForSelector('[data-flow-cover] .fy-loading--page');
      const stepDelay = await tab.$eval(
        '[data-flow-cover] .fy-loading--page',
        el => getComputedStyle(el).animationDelay,
      );
      console.info(`step cover loader animation-delay: ${stepDelay}`);
      expect(stepDelay, 'the step cover has already waited, so its loader fades in at once').toBe('0s');
    } finally {
      await context.close();
    }
  });

  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`a page that answers in 250 ms never has a loader visible (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.addInitScript(LOADER_SAMPLER);
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=late&ms=250`);
          await tab.waitForFunction(() => (window as unknown as { __readyAt?: number }).__readyAt !== undefined);
          await tab.waitForTimeout(700);
          const seen = await tab.evaluate(() => (window as unknown as { __loader: { frames: number } }).__loader);
          expect(seen.frames, 'no frame had a visible loader (checked every frame for 700 ms)').toBe(0);
          expect(await tab.$('[data-flow-cover]'), 'the cover is gone once the page is ready').toBeNull();
        } finally {
          await context.close();
        }
      });
      it(`a page that answers in 600 ms has the loader from 300 ms on, not before (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.addInitScript(LOADER_SAMPLER);
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=late&ms=600`);
          await tab.waitForFunction(() => (window as unknown as { __readyAt?: number }).__readyAt !== undefined);
          const seen = await tab.evaluate(() => {
            const w = window as unknown as {
              __loader: { first: number; last: number; frames: number };
              __pageMountedAt: number;
            };
            return { ...w.__loader, mounted: w.__pageMountedAt };
          });
          expect(seen.frames, 'the loader was drawn').toBeGreaterThan(0);
          const from = seen.first - seen.mounted;
          console.info(
            `loader first visible ${from.toFixed(0)} ms after the page mounted (${viewport.name}, ${scheme})`,
          );
          expect(from, `the loader first shows at ${from.toFixed(0)} ms: not before 300`).toBeGreaterThanOrEqual(295);
          expect(from, `and soon after 300 (${from.toFixed(0)} ms)`).toBeLessThanOrEqual(420);
        } finally {
          await context.close();
        }
      });
    }
});

// r11-1b G6 (owner line 4): the step cover never blinks, and the next page is drawn in advance.
describe('r11-1b G6: no cover blink, no first-draw hold', () => {
  const open = async (scheme: 'light' | 'dark', width: number, height: number) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    return { context, origin, tab: await context.newPage() };
  };
  /** The cover holds its loader for fade + min = 460 ms from the moment the loader is mounted (a little slack for the timer). */
  const HELD_AT_LEAST_MS = 450;
  /** When the cover's loader is put into the document and when it leaves it (a MutationObserver, so a busy frame loop cannot skew it). */
  const COVER_WATCH = `
    window.__cover = { in: -1, out: -1 };
    const look = () => {
      const now = performance.now();
      const there = document.querySelector('[data-flow-cover] [data-loading]') !== null;
      if (there && window.__cover.in < 0) window.__cover.in = now;
      if (!there && window.__cover.in >= 0 && window.__cover.out < 0) window.__cover.out = now;
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  `;

  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      // A page that answers 40 ms after the cover's loader came up (answers at 100 ms: 300 + 40): onboarding.name 36 ms,
      // warden 39 ms at the gate. The loader must stay for its minimum, not vanish after those few frames.
      it(`a cover that came up for a 340 ms answer stays for its minimum, then the page shows (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.addInitScript(COVER_WATCH);
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=late&ms=340`);
          await tab.waitForFunction(() => (window as unknown as { __readyAt?: number }).__readyAt !== undefined);
          // The page has answered; the cover is still up (held for its minimum).
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-g6-cover-held.png`) });
          await tab.waitForSelector('[data-flow-cover]', { state: 'detached' });
          await tab.waitForTimeout(200);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-g6-page-after.png`) });
          const seen = await tab.evaluate(
            () => (window as unknown as { __cover: { in: number; out: number } }).__cover,
          );
          const shown = seen.out - seen.in;
          console.info(
            `G6 cover loader held ${shown.toFixed(0)} ms after a 340 ms answer (${viewport.name}, ${scheme})`,
          );
          expect(seen.in, 'the loader was mounted').toBeGreaterThan(0);
          expect(seen.out, 'and then left').toBeGreaterThan(seen.in);
          expect(shown, `the loader was held ${shown.toFixed(0)} ms: not a blink`).toBeGreaterThanOrEqual(
            HELD_AT_LEAST_MS,
          );
          expect(await tab.$('[data-flow-page]:not([hidden]) [data-flow-slot]:not([hidden])')).not.toBeNull();
          expect(await tab.$('[data-flow-page][data-ready]'), 'the page shows after the hold').not.toBeNull();
        } finally {
          await context.close();
        }
      });
    }

  // With Settings > Motion > Reduced the shared !important rule (ui/loading.css) used to add a SECOND 300 ms delay to the loader the
  // cover had already waited for, while the hold clock ran from the loader's mount: a 340 ms answer sat behind a BLANK cover and the
  // loader was visible for ~130 ms (440 ms in normal motion). Counted by what is on screen (opacity, every frame), not by DOM presence.
  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`in reduced motion a 340 ms answer still has its loader on screen for its minimum, from 300 ms on (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.addInitScript(LOADER_SAMPLER);
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=late&ms=340&motion=reduced`);
          await tab.waitForFunction(() => (window as unknown as { __readyAt?: number }).__readyAt !== undefined);
          await tab.waitForSelector('[data-flow-cover]', { state: 'detached' });
          const seen = await tab.evaluate(() => {
            const w = window as unknown as {
              __loader: { first: number; last: number; frames: number };
              __pageMountedAt: number;
            };
            return { ...w.__loader, mounted: w.__pageMountedAt };
          });
          expect(seen.frames, 'the loader was visible on some frame').toBeGreaterThan(0);
          const from = seen.first - seen.mounted;
          const shown = seen.last - seen.first;
          console.info(
            `G6 reduced motion: loader visible from ${from.toFixed(0)} ms for ${shown.toFixed(0)} ms (${viewport.name}, ${scheme})`,
          );
          expect(from, `the loader shows at ${from.toFixed(0)} ms: not before 300`).toBeGreaterThanOrEqual(295);
          expect(
            from,
            `and at once after the cover's own wait, not a second 300 ms (${from.toFixed(0)} ms)`,
          ).toBeLessThanOrEqual(420);
          expect(shown, `the loader was on screen ${shown.toFixed(0)} ms: not a blink`).toBeGreaterThanOrEqual(
            HELD_AT_LEAST_MS - 100,
          );
        } finally {
          await context.close();
        }
      });
    }

  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`a lazy second page, drawn in advance, is ready in under 150 ms of Next with no loader (${viewport.name}, ${scheme})`, async () => {
        const { context, origin, tab } = await open(scheme, viewport.width, viewport.height);
        try {
          await tab.addInitScript(LOADER_SAMPLER);
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=prefetch`);
          await tab.waitForSelector('[data-flow-page="fake-pack.choose"][data-ready]');
          // Long enough for the hidden pre-render to have loaded the module (20 ms) and settled.
          await tab.waitForTimeout(700);
          expect(
            await tab.evaluate(() => (window as unknown as { __secondReadyAt?: number }).__secondReadyAt),
            'the hidden pre-render runs no effect of the page',
          ).toBeUndefined();
          await tab.click('[data-step-next]');
          await tab.waitForFunction(
            () => (window as unknown as { __secondReadyAt?: number }).__secondReadyAt !== undefined,
          );
          const at = await tab.evaluate(() => {
            const w = window as unknown as { __nextAt: number; __secondReadyAt: number; __loader: { frames: number } };
            return { ms: w.__secondReadyAt - w.__nextAt, frames: w.__loader.frames };
          });
          await tab.waitForTimeout(300);
          console.info(`G6 Next to ready on a lazy page ${at.ms.toFixed(0)} ms (${viewport.name}, ${scheme})`);
          expect(at.ms, `Next to ready took ${at.ms.toFixed(0)} ms`).toBeLessThan(150);
          const frames = await tab.evaluate(
            () => (window as unknown as { __loader: { frames: number } }).__loader.frames,
          );
          expect(frames, 'no loader was ever drawn on this move').toBe(0);
          expect(await tab.$('[data-flow-prefetch]'), 'the pre-render is never in the document').toBeNull();
        } finally {
          await context.close();
        }
      });
    }
});
