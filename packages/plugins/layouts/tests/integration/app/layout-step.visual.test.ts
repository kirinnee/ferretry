/**
 * THE LAYOUT STEP (r11 O11) in a real browser over fake data (`fixtures/layout-step-scene.tsx`): stacked cards, one demo on the right, Next saves,
 * the demo of a pick plays once and then rests, motion off plays
 * nothing, and the page never scrolls sideways.
 *
 * Set `FY_LAYOUT_STEP_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-step-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/layout-step-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the layout step scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query = '') => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
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
  await tab.waitForSelector('[data-layout-step] [data-choice-cards]');
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`), fullPage: true });
};

/** Jump every running animation to `ms` and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

declare global {
  interface Window {
    __writes: string[];
    __demoEvents: string[];
  }
}

/** Record every CSS animation event inside the DEMO column only (the cards' own motion is not the demo's). */
const watchDemo = async (tab: Page): Promise<void> => {
  await tab.evaluate(() => {
    window.__demoEvents = [];
    for (const type of ['animationstart', 'animationiteration', 'animationend', 'animationcancel'])
      document.addEventListener(
        type,
        event => {
          const target = event.target as HTMLElement;
          if (target.closest('[data-step-demo]') === null) return;
          window.__demoEvents.push(`${type}:${(event as AnimationEvent).animationName}:${target.className}`);
        },
        true,
      );
  });
};

/** What the demo column is animating right now (not the cards, not the page). */
const demoRunning = async (tab: Page): Promise<number> =>
  await tab.evaluate(
    () =>
      (document.querySelector('[data-step-demo]') as Element)
        .getAnimations({ subtree: true })
        .filter(animation => animation.playState === 'running').length,
  );

/** Wait, in real time and without touching a clock, until the demo is at rest; return how long that took. */
const demoSettles = async (tab: Page): Promise<number> => {
  const started = Date.now();
  await tab.waitForFunction(
    () =>
      (document.querySelector('[data-step-demo]') as Element)
        .getAnimations({ subtree: true })
        .every(animation => animation.playState !== 'running'),
    undefined,
    { timeout: 2_000, polling: 'raf' },
  );
  return Date.now() - started;
};

describe('r11 O11: the first-run Layout page', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: stacked cards, the demo on the right, short words, nothing to press but the footer`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'rest');
        const m = await tab.evaluate(() => {
          const measure = (node: Element | null) => {
            const r = node?.getBoundingClientRect() ?? new DOMRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
          };
          const body = document.querySelector('.fy-spf__body') as HTMLElement;
          const groups = [...document.querySelectorAll('[data-layout-step] [role="radiogroup"]')];
          return {
            groups: groups.map(group => [...group.querySelectorAll('[data-choice]')].map(measure)),
            allCards: [...document.querySelectorAll('[data-layout-step] [data-choice]')].map(measure),
            demo: measure(document.querySelector('[data-step-demo]')),
            demoScene: document.querySelector('[data-step-demo] [data-layout-demo]') !== null,
            // EVERYTHING the page shows, headings and card titles included, whitespace folded (the plan's 160-character limit).
            bodyText: body.innerText.replace(/\s+/g, ' ').trim(),
            bodyButtons: body.querySelectorAll('button:not([role=radio])').length,
            dockTops: [...document.querySelectorAll('[data-step-demo] .fy-lstep-demo__dock span')].map(
              span => span.getBoundingClientRect().top,
            ),
            oldCards: document.querySelectorAll('[data-choice="bottom"], [data-choice="left"]').length,
            cardDemos: document.querySelectorAll('[data-layout-step] .fy-cc__demo').length,
            footer: ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(s =>
              measure(document.querySelector(s)),
            ),
            viewport: window.innerWidth,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });
        expect(problems).toEqual([]);
        expect(m.allCards).toHaveLength(4);
        expect(m.oldCards, 'no Side bar / Bottom bar cards').toBe(0);
        expect(m.cardDemos, 'the demo is the one on the right, not one inside each card').toBe(0);
        expect(m.demoScene).toBe(true);
        expect(new Set(m.dockTops).size, 'the icons sit on one row').toBe(1);
        // Each question's cards are stacked: one x and width, y strictly increasing.
        for (const cards of m.groups) {
          expect(cards).toHaveLength(2);
          expect(Math.abs(cards[0]!.x - cards[1]!.x)).toBeLessThan(0.5);
          expect(Math.abs(cards[0]!.w - cards[1]!.w)).toBeLessThan(0.5);
          expect(cards[1]!.y).toBeGreaterThan(cards[0]!.bottom - 0.5);
        }
        if (variant.phone) {
          expect(m.demo.bottom).toBeLessThanOrEqual(m.allCards[0]!.y + 1);
          expect(m.demo.h).toBeLessThanOrEqual(140);
          expect(m.overflowX, 'no sideways scroll').toBe(false);
          for (const button of m.footer) {
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(m.viewport);
          }
        } else {
          const cardsRight = Math.max(...m.allCards.map(card => card.right));
          expect(m.demo.x, 'the demo is right of the cards').toBeGreaterThan(cardsRight + 32);
          expect(Math.abs(m.demo.y - m.allCards[0]!.y), 'top-aligned with the first card').toBeLessThanOrEqual(48);
        }
        expect(m.bodyText.length, `the page's words: ${JSON.stringify(m.bodyText)}`).toBeLessThanOrEqual(160);
        expect(m.bodyButtons, 'no button of its own on the page').toBe(0);
        console.log(
          `[O11 ${variant.name}] demo.x=${Math.round(m.demo.x)} demo.h=${Math.round(m.demo.h)} cardsRight=${Math.round(Math.max(...m.allCards.map(card => card.right)))} text=${m.bodyText.length}`,
        );
      } finally {
        await close();
      }
    });

    if (shotsDir !== '')
      it(`${variant.name}: shot the demo mid-move`, async () => {
        const { tab, close } = await open(variant);
        try {
          await tab.locator('[data-choice="words"]').click();
          await tab.locator('[data-choice="compact"]').click();
          await seek(tab, 120);
          await shot(tab, variant, 'mid-animation');
        } finally {
          await close();
        }
      });

    it(`${variant.name}: a pick writes nothing, the demo follows it, and Next writes once`, async () => {
      const { tab, close } = await open(variant);
      try {
        const demo = (name: string, value: string) => `[data-step-demo] [data-layout-demo][data-${name}="${value}"]`;
        expect(await tab.locator(demo('labels', 'icons')).count()).toBe(1);
        expect(await demoRunning(tab), 'the demo rests before any pick').toBe(0);
        await watchDemo(tab);

        // Words: the DOCK plays once, by itself (no seek, no finish), and rests.
        await tab.locator('[data-choice="words"]').click();
        const dockRunning = await tab.evaluate(
          () => (document.querySelector('[data-step-demo] .fy-lstep-demo__dock') as Element).getAnimations().length,
        );
        expect(dockRunning, 'the dock moves when Words is picked').toBeGreaterThan(0);
        const dockMs = await demoSettles(tab);
        await tab.waitForTimeout(700); // longer than any of the demo's own animations: a repeat would show here
        const dockEvents = await tab.evaluate(() => window.__demoEvents);
        expect(
          dockEvents.filter(event => event.startsWith('animationstart:fy-lstep-rise')),
          'the dock starts once',
        ).toHaveLength(1);
        expect(
          dockEvents.filter(event => event.startsWith('animationend:fy-lstep-rise')),
          'the dock ends once',
        ).toHaveLength(1);
        expect(
          dockEvents.filter(event => /^animation(iteration|cancel)/.test(event)),
          'nothing repeats or is cut',
        ).toEqual([]);
        expect(
          dockEvents.every(event => event.includes('fy-lstep-demo__dock')),
          'only the dock moved',
        ).toBe(true);
        expect(await demoRunning(tab), 'the dock came to rest on its own').toBe(0);
        expect(await tab.locator(demo('labels', 'words')).count(), 'the picture shows Words').toBe(1);

        // Compact: the ROWS play once each, by themselves, and rest.
        await tab.evaluate(() => {
          window.__demoEvents = [];
        });
        await tab.locator('[data-choice="compact"]').click();
        const rowsRunning = await tab.evaluate(
          () =>
            [...document.querySelectorAll('[data-step-demo] .fy-lstep-demo__row')].flatMap(row => row.getAnimations())
              .length,
        );
        expect(rowsRunning, 'the rows move when Compact is picked').toBeGreaterThan(0);
        const rowsMs = await demoSettles(tab);
        await tab.waitForTimeout(700);
        const rowEvents = await tab.evaluate(() => window.__demoEvents);
        const rowCount = await tab.locator('[data-step-demo] .fy-lstep-demo__row').count();
        expect(
          rowEvents.filter(event => event.startsWith('animationstart:fy-lstep-rise')),
          'each row starts once',
        ).toHaveLength(rowCount);
        expect(
          rowEvents.filter(event => event.startsWith('animationend:fy-lstep-rise')),
          'each row ends once',
        ).toHaveLength(rowCount);
        expect(
          rowEvents.filter(event => /^animation(iteration|cancel)/.test(event)),
          'nothing repeats or is cut',
        ).toEqual([]);
        expect(
          rowEvents.every(event => event.includes('fy-lstep-demo__row')),
          'only the rows moved',
        ).toBe(true);
        expect(await demoRunning(tab), 'the rows came to rest on their own').toBe(0);
        expect(await tab.locator(demo('density', 'compact')).count(), 'the picture shows Compact').toBe(1);
        console.log(
          `[O11 ${variant.name}] dock settled in ${dockMs}ms (${dockEvents.length} events), rows settled in ${rowsMs}ms (${rowCount} rows, ${rowEvents.length} events)`,
        );
        await shot(tab, variant, 'chosen');
        expect(await tab.evaluate(() => window.__writes), 'a click writes nothing').toEqual([]);
        await tab.locator('[data-step-next]').click();
        await tab.waitForFunction(() => window.__writes.length >= 2);
        await tab.waitForTimeout(150);
        expect(await tab.evaluate(() => window.__writes), 'Next writes each changed answer once').toEqual([
          'nav.labels=words',
          'density=compact',
        ]);
        const picked = await tab.$$eval('[data-layout-step] input:checked', inputs =>
          inputs.map(input => (input as HTMLInputElement).value),
        );
        expect(picked).toEqual(['words', 'compact']);
      } finally {
        await close();
      }
    });
  }

  it('Next with nothing changed writes nothing, and picking the saved answer back clears the write', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-choice="words"]').click();
      await tab.locator('[data-choice="icons"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.waitForTimeout(200);
      expect(await tab.evaluate(() => window.__writes)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('390: Icons takes effect on a phone whose layout sets phone.nav.labels=words (the phone key is written where it wins)', async () => {
    const phone = VARIANTS[2];
    const { tab, close } = await open(phone, '&phoneLabels=words');
    try {
      const nav = (value: string) => tab.locator(`[aria-label="Navigation"] input[value="${value}"]`);
      expect(await nav('words').isChecked(), 'the phone starts on the Words its layout set').toBe(true);
      await tab.locator('[data-choice="icons"]').click();
      expect(await nav('icons').isChecked(), 'the picked card is Icons').toBe(true);
      await tab.locator('[data-step-next]').click();
      await tab.waitForFunction(() => window.__writes.length >= 2);
      expect(await tab.evaluate(() => window.__writes)).toEqual(['nav.labels=icons', 'phone.nav.labels=icons']);
      expect(await nav('icons').isChecked(), 'the EFFECTIVE phone choice is now Icons').toBe(true);
      await shot(tab, phone, 'phone-label-override');
    } finally {
      await close();
    }
  });

  it('with motion off nothing plays at all', async () => {
    const { tab, close } = await open(VARIANTS[0], '&motion=reduced');
    try {
      await tab.locator('[data-choice="words"]').click();
      await tab.locator('[data-choice="compact"]').click();
      const moving = await tab.evaluate(
        () => document.getAnimations().filter(animation => animation.playState === 'running').length,
      );
      expect(moving).toBe(0);
    } finally {
      await close();
    }
  });
});
