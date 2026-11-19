/**
 * CHOICE CARDS and the STEP PAGE FRAME in a real browser over fake data (`fixtures/choice-cards-scene.tsx`): how many
 * cards share a row at a given group width (3 in one row at 832, 5 wrap 4 + 1 at 1280, stacked below 480, never wider
 * than 320 on a desktop), the real CSS under the OS reduced-motion preference (no border/fill fade, no scale), and the
 * frame's footer (auto-width buttons, >= 44px tall, sticky on a phone, in view at 390).
 *
 * Set `FY_CHOICE_CARDS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CHOICE_CARDS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-choice-cards-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/choice-cards-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the choice cards scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 800, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 800, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query: string, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
    reducedMotion,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('[data-choice-cards], [data-step-page]');
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

/** The cards' boxes, and how many distinct rows they sit in. */
const layoutOf = async (tab: Page) =>
  await tab.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.fy-cc__card')].map(card => card.getBoundingClientRect());
    const rows = [...new Set(boxes.map(box => Math.round(box.top)))];
    const perRow = rows.map(top => boxes.filter(box => Math.round(box.top) === top).length);
    return { widths: boxes.map(box => Math.round(box.width)), perRow };
  });

describe('ChoiceCards layout', () => {
  it('should put 3 cards in ONE row in an 832px group, each at most 320px', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=3&w=832');
    try {
      const { widths, perRow } = await layoutOf(tab);
      expect(perRow).toEqual([3]);
      expect(Math.max(...widths)).toBeLessThanOrEqual(320);
    } finally {
      await close();
    }
  });

  it('should wrap 5 cards 4 + 1 at 1280, never more than 4 to a row and never wider than 320px', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=5');
    try {
      const { widths, perRow } = await layoutOf(tab);
      expect(perRow).toEqual([4, 1]);
      expect(Math.max(...widths)).toBeLessThanOrEqual(320);
    } finally {
      await close();
    }
  });

  it('should not stretch 2 cards across a wide page', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=2');
    try {
      const { widths, perRow } = await layoutOf(tab);
      expect(perRow).toEqual([2]);
      expect(widths).toEqual([320, 320]);
    } finally {
      await close();
    }
  });

  it('should let tracks shrink to 180px before wrapping, and stack only below 480', async () => {
    const wide = await open(VARIANTS[0], '&scene=cards&n=3&w=580');
    try {
      expect((await layoutOf(wide.tab)).perRow).toEqual([3]);
      expect(Math.min(...(await layoutOf(wide.tab)).widths)).toBeGreaterThanOrEqual(180);
    } finally {
      await wide.close();
    }
    const narrow = await open(VARIANTS[0], '&scene=cards&n=3&w=470');
    try {
      expect((await layoutOf(narrow.tab)).perRow).toEqual([1, 1, 1]);
    } finally {
      await narrow.close();
    }
  });

  for (const variant of VARIANTS) {
    for (const count of [2, 3, 5]) {
      it(`${variant.name}: ${count} cards, no page overflow, shot`, async () => {
        const { tab, problems, close } = await open(variant, `&scene=cards&n=${count}`);
        try {
          const { widths } = await layoutOf(tab);
          expect(widths.length).toBe(count);
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
          ).toBe(true);
          if (!variant.phone) expect(Math.max(...widths)).toBeLessThanOrEqual(320);
          await shotOf(tab, variant, `cards-${count}`);
          if (count === 3) {
            await tab.locator('[data-choice="right"]').click();
            await tab.evaluate(() => {
              for (const animation of document.getAnimations()) {
                animation.pause();
                animation.currentTime = 70;
              }
            });
            await shotOf(tab, variant, 'cards-3-mid-animation');
          }
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }
});

/** The longest of a computed `transition-duration` list, in ms. The app's global reduced-motion rule floors it at 1ms. */
const longestMs = (list: string): number =>
  Math.max(
    ...list
      .split(',')
      .map(part => (part.trim().endsWith('ms') ? Number.parseFloat(part) : Number.parseFloat(part) * 1_000)),
  );

/** A card's computed motion: the longest transition and whether the pop animation is attached. */
const motionOf = async (tab: Page, id: string) =>
  await tab.locator(`[data-choice="${id}"]`).evaluate(card => {
    const style = getComputedStyle(card);
    return {
      transition: style.transitionDuration,
      animation: style.animationName,
      running: card.getAnimations().length,
    };
  });

describe('ChoiceCards motion in the real CSS', () => {
  it('should fade 160ms and pop on select with motion allowed', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=3');
    try {
      expect(longestMs((await motionOf(tab, 'right')).transition)).toBe(160);
      await tab.locator('[data-choice="right"]').click();
      const after = await motionOf(tab, 'right');
      expect(after.animation).toBe('fy-cc-pop');
    } finally {
      await close();
    }
  });

  it('should have NO transition and NO animation under the OS prefers-reduced-motion: reduce', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=3', 'reduce');
    try {
      expect(await tab.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      expect(await tab.evaluate(() => document.documentElement.dataset.motion)).toBeUndefined();
      await tab.locator('[data-choice="right"]').click();
      for (const id of ['left', 'right', 'bottom']) {
        const motion = await motionOf(tab, id);
        expect(longestMs(motion.transition)).toBeLessThanOrEqual(1);
        expect(motion.animation).toBe('none');
        expect(motion.running).toBe(0);
      }
      expect(await tab.locator('[data-choice="right"]').getAttribute('data-selected')).toBe('true');
    } finally {
      await close();
    }
  });

  it('should carry its OWN reduce rule (the app-wide 1ms floor is not what turns the fade off)', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=3', 'reduce');
    try {
      const own = await tab.evaluate(() => {
        const found: string[] = [];
        for (const sheet of document.styleSheets)
          for (const rule of sheet.cssRules)
            if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion: reduce'))
              for (const inner of rule.cssRules)
                if (inner instanceof CSSStyleRule && inner.selectorText === '.fy-cc__card')
                  found.push(
                    `${inner.style.getPropertyValue('transition')}|${inner.style.getPropertyValue('animation-name')}`,
                  );
        return found;
      });
      expect(own).toEqual(['none|none']);
    } finally {
      await close();
    }
  });

  it('should have NO transition and NO animation under the app setting (data-motion=reduced) alone', async () => {
    const { tab, close } = await open(VARIANTS[0], '&scene=cards&n=3&motion=reduced');
    try {
      await tab.locator('[data-choice="right"]').click();
      const motion = await motionOf(tab, 'right');
      expect(longestMs(motion.transition)).toBeLessThanOrEqual(1);
      expect(motion.animation).toBe('none');
    } finally {
      await close();
    }
  });
});

describe('StepPageFrame in a real browser', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: footer buttons are auto width, >= 44px tall, ${variant.phone ? 'sticky and in view' : 'right aligned'}`, async () => {
      const { tab, problems, close } = await open(variant, variant.phone ? '&scene=frame&tall=1' : '&scene=frame');
      try {
        const info = await tab.evaluate(() => {
          const rect = (selector: string) => {
            const node = document.querySelector<HTMLElement>(selector);
            const box = node?.getBoundingClientRect();
            return {
              top: box?.top ?? 0,
              bottom: box?.bottom ?? 0,
              left: box?.left ?? 0,
              right: box?.right ?? 0,
              width: box?.width ?? 0,
              height: box?.height ?? 0,
            };
          };
          const next = document.querySelector<HTMLElement>('[data-step-next]');
          const style = next === null ? null : getComputedStyle(next);
          return {
            next: rect('[data-step-next]'),
            back: rect('[data-step-back]'),
            footer: rect('[data-step-footer]'),
            position: getComputedStyle(document.querySelector('[data-step-footer]') as Element).position,
            paddingTop: Number.parseFloat(style?.paddingTop ?? '0'),
            paddingBottom: Number.parseFloat(style?.paddingBottom ?? '0'),
            nextContrast: (() => {
              const channels = (value: string) => (value.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
              const lum = ([r, g, b]: number[]) => {
                const lin = (c: number) => (c / 255) ** 2.2;
                return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
              };
              const node = document.querySelector<HTMLElement>('[data-step-next]') as HTMLElement;
              const style = getComputedStyle(node);
              const [hi, lo] = [lum(channels(style.color)), lum(channels(style.backgroundColor))].sort((x, y) => y - x);
              return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
            })(),
            viewport: window.innerHeight,
            viewportWidth: window.innerWidth,
            scrollable: (document.querySelector('[data-scroller]') as HTMLElement).scrollHeight,
            demo: rect('[data-step-demo]'),
            tracks: [...document.querySelectorAll<HTMLElement>('[data-option-bar-track]')].map(track => ({
              track: track.getBoundingClientRect().width,
              fill: (track.querySelector('[data-option-bar-fill]') as HTMLElement).getBoundingClientRect().width,
              height: track.getBoundingClientRect().height,
            })),
            demoInner: (document.querySelector('[data-step-demo]') as HTMLElement).clientWidth,
            body: rect('.fy-spf__body'),
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });
        expect(info.next.height).toBeGreaterThanOrEqual(44);
        expect(info.back.height).toBeGreaterThanOrEqual(44);
        expect(info.paddingTop).toBeGreaterThanOrEqual(12);
        expect(info.paddingTop).toBeLessThanOrEqual(16);
        expect(info.paddingBottom).toBeGreaterThanOrEqual(12);
        expect(info.paddingBottom).toBeLessThanOrEqual(16);
        // Auto width: a small share of the page, never a stretched bar.
        expect(info.next.width).toBeLessThan(info.viewportWidth * 0.5);
        expect(info.back.width).toBeLessThan(info.viewportWidth * 0.5);
        expect(info.overflowX).toBe(false);
        // OptionBars inside the centred demo box keep a usable track, and the fill is its share of it (0.8, 0.5).
        expect(info.tracks).toHaveLength(2);
        for (const [index, share] of [0.8, 0.5].entries()) {
          const bar = info.tracks[index] as { track: number; fill: number; height: number };
          expect(bar.track).toBeGreaterThanOrEqual(64);
          expect(bar.height).toBeGreaterThan(0);
          expect(bar.track).toBeLessThanOrEqual(info.demoInner);
          expect(Math.abs(bar.fill - bar.track * share)).toBeLessThanOrEqual(1.5);
        }
        // Next's label reads on its fill (WCAG 4.5:1), light and dark.
        expect(info.nextContrast).toBeGreaterThanOrEqual(4.5);
        if (variant.phone) {
          // The page is taller than the screen, so a sticky footer is the only way it is in view at the start.
          expect(info.scrollable).toBeGreaterThan(info.viewport);
          expect(info.position).toBe('sticky');
          expect(info.footer.bottom).toBeLessThanOrEqual(info.viewport + 0.5);
          expect(info.footer.bottom).toBeGreaterThan(info.viewport - 1);
          // The demo sits above the body and is short.
          expect(info.demo.bottom).toBeLessThanOrEqual(info.body.top + 0.5);
          expect(info.demo.height).toBeLessThanOrEqual(120);
        } else {
          // The whole footer is on screen at the start, and Next is the right-most control.
          expect(info.footer.bottom).toBeLessThanOrEqual(info.viewport + 0.5);
          expect(info.next.right).toBeGreaterThan(info.back.right);
          expect(info.demo.left).toBeGreaterThan(info.body.left);
        }
        await shotOf(tab, variant, 'step-frame');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
