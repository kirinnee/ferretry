/**
 * THE ONBOARDING APPEARANCE STEP (r11 G2, owner line 3) in a real browser over fake data (`fixtures/appearance-step-scene.tsx`):
 * the choices are a GRID OF SMALL CARDS (C59 O6c: several to a row, never full-width bars), the live theme demo sits to the RIGHT of
 * them at 1280 and above them at 390, the page text (the slot's text minus the card titles) is at most 160 characters, and a pick restyles the page and
 * the demo at once.
 *
 * Set `FY_APPEARANCE_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { PALETTES, STYLES } from '@ferretry/app';
import { demoScroll, pinnedStrip, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_APPEARANCE_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-appearance-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/appearance-step-scene.tsx'],
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
interface Variant {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly scheme: 'light' | 'dark';
}

/** The most characters the page may say, not counting the card titles (owner line 3). */
const TEXT_LIMIT = 160;

const open = async (variant: Variant) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-flow-slot]:not([hidden]) [data-choice-cards]');
  await tab.waitForTimeout(400);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
}

/** The measures the owner's line 3 names, read from the live page. */
const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    };
    const groups = [...document.querySelectorAll<HTMLElement>('[data-choice-cards]')].map(group => ({
      layout: group.dataset.layout ?? '',
      cards: [...group.querySelectorAll('.fy-cc__card')].map(box),
    }));
    const slot = document.querySelector('.fy-sf-slot') as HTMLElement;
    // What a person reads in the slot (`innerText`, so styling and hidden parts count as they do on screen), minus ONLY the card titles.
    let text = slot.innerText;
    for (const title of slot.querySelectorAll<HTMLElement>('.fy-cc__title')) text = text.replace(title.innerText, '');
    text = text.replace(/\s+/g, ' ').trim();
    const demo = document.querySelector('[data-step-demo]') as HTMLElement | null;
    const painted =
      demo === null ? [] : [...demo.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0);
    return {
      groups,
      labels: [...slot.querySelectorAll('[role=radiogroup]')].map(group => group.getAttribute('aria-label') ?? ''),
      // Each section's own heading and the radio-group labels INSIDE it, so the grouping (not only the flat order) is read.
      sections: [...slot.querySelectorAll<HTMLElement>('section[data-appearance-group]')].map(section => ({
        heading: (section.querySelector('h2') as HTMLElement | null)?.innerText.trim() ?? '',
        labels: [...section.querySelectorAll('[role=radiogroup]')].map(group => group.getAttribute('aria-label') ?? ''),
      })),
      text,
      demo: demo === null ? null : box(demo),
      demoPainted: painted.length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

/** The live sample's own facts: its words at their drawn size, and whether its motion strip is sweeping. */
const sample = async (tab: Page) =>
  await tab.evaluate(() => {
    const demo = document.querySelector('[data-appearance-demo]') as HTMLElement;
    const size = (selector: string) =>
      Number.parseFloat(getComputedStyle(demo.querySelector(selector) as Element).fontSize);
    const button = (demo.querySelector('.fy-ad__button') as HTMLElement).getBoundingClientRect();
    return {
      text: size('.fy-ad__text'),
      button: size('.fy-ad__button'),
      input: size('.fy-ad__input'),
      buttonHeight: Math.round(button.height * 10) / 10,
      moving: demo.dataset.moving ?? '',
      sweep: getComputedStyle(demo.querySelector('.fy-ad__run i') as Element).animationName,
      spinner: getComputedStyle(demo.querySelector('[data-spinner]') as Element).animationName,
    };
  });

describe('the live sample shows text size and motion (C59 O6)', () => {
  it("the three text sizes grow the sample's words, and each step is bigger than the one before (1280 light)", async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      const sizes: Record<string, Awaited<ReturnType<typeof sample>>> = {};
      for (const choice of ['default', 'large', 'larger']) {
        await tab.locator(`[aria-label="Text size"] .fy-cc__card[data-choice="${choice}"]`).click();
        await tab.waitForTimeout(250);
        sizes[choice] = await sample(tab);
      }
      const [a, b, c] = [sizes.default, sizes.large, sizes.larger] as [
        Awaited<ReturnType<typeof sample>>,
        Awaited<ReturnType<typeof sample>>,
        Awaited<ReturnType<typeof sample>>,
      ];
      for (const key of ['text', 'button', 'input'] as const) {
        expect(b[key], `${key} large > default`).toBeGreaterThan(a[key]);
        expect(c[key], `${key} larger > large`).toBeGreaterThan(b[key]);
      }
      console.log(
        `MEASURED sample text size px: default=${a.text} large=${b.text} larger=${c.text}; button ${a.button}/${b.button}/${c.button}`,
      );
    } finally {
      await close();
    }
  });

  // The phone's demo column is at most 140px tall and clips what does not fit: every part of the sample, the motion strip
  // included, must be inside it at every text size (it was cut at its foot).
  for (const variant of [VARIANTS[2], VARIANTS[3]])
    it(`nothing of the sample is clipped by the phone's 140px column, at every text size (${variant.name})`, async () => {
      const { tab, close } = await open(variant);
      try {
        for (const choice of ['default', 'large', 'larger']) {
          await tab.locator(`[aria-label="Text size"] .fy-cc__card[data-choice="${choice}"]`).click();
          await tab.waitForTimeout(250);
          const fit = await tab.evaluate(() => {
            const column = (document.querySelector('[data-step-demo]') as HTMLElement).getBoundingClientRect();
            const parts = [...document.querySelectorAll<HTMLElement>('[data-appearance-demo] .fy-ad__window *')].filter(
              element => element.getBoundingClientRect().height > 0,
            );
            const lowest = Math.max(...parts.map(element => element.getBoundingClientRect().bottom));
            const motion = (
              document.querySelector('[data-appearance-demo-motion]') as HTMLElement
            ).getBoundingClientRect();
            return {
              column: Math.round(column.bottom),
              lowest: Math.round(lowest),
              motionBottom: Math.round(motion.bottom),
              height: Math.round(column.height),
            };
          });
          console.log(
            `MEASURED ${variant.name} text ${choice}: column bottom ${fit.column}, lowest part ${fit.lowest}, motion strip bottom ${fit.motionBottom}, column height ${fit.height}`,
          );
          expect(fit.motionBottom, `${choice}: motion strip bottom`).toBeLessThanOrEqual(fit.column - 1);
          expect(fit.lowest, `${choice}: lowest part`).toBeLessThanOrEqual(fit.column - 1);
        }
      } finally {
        await close();
      }
    });

  it('the motion strip sweeps and the busy mark turns, until Reduced is picked (1280 light)', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      const moving = await sample(tab);
      expect(moving.moving).toBe('true');
      expect(moving.sweep).toBe('fy-ad-sweep');
      expect(moving.spinner).not.toBe('none');
      // The sweep is live, not just named: the bar's transform changes between two frames.
      const frame = async () =>
        await tab.evaluate(
          () => getComputedStyle(document.querySelector('[data-appearance-demo] .fy-ad__run i') as Element).transform,
        );
      const first = await frame();
      await tab.waitForTimeout(350);
      expect(await frame()).not.toBe(first);
      await tab.locator('[aria-label="Motion"] .fy-cc__card[data-choice="reduced"]').click();
      await tab.waitForTimeout(250);
      const still = await sample(tab);
      expect(still.moving).toBe('false');
      expect(still.sweep).toBe('none');
      const rest = await frame();
      await tab.waitForTimeout(350);
      expect(await frame()).toBe(rest);
      console.log(
        `MEASURED motion: sweep ${moving.sweep} -> ${still.sweep}; spinner ${moving.spinner} -> ${still.spinner}`,
      );
    } finally {
      await close();
    }
  });

  it('respects the OS prefers-reduced-motion setting too, with the motion pick left on Follow system (1280 light)', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      await tab.emulateMedia({ reducedMotion: 'reduce' });
      await tab.waitForTimeout(250);
      const still = await sample(tab);
      expect(still.moving).toBe('false');
      expect(still.sweep).toBe('none');
    } finally {
      await close();
    }
  });
});

describe('the new palettes on the Appearance page (C59 O6)', () => {
  for (const variant of VARIANTS)
    for (const palette of ['mesh', 'aurora', 'afterglow', 'briefing'])
      it(`${palette} restyles the page and the sample, draws its own named card, and keeps the page readable (${variant.name})`, async () => {
        const { tab, close } = await open(variant);
        try {
          const read = async () =>
            await tab.evaluate(() => {
              const demo = document.querySelector('[data-appearance-demo]') as HTMLElement;
              return {
                palette: document.documentElement.dataset.palette ?? '',
                accent: getComputedStyle(demo.querySelector('[data-appearance-demo-accent]') as Element)
                  .backgroundColor,
                mesh: getComputedStyle(document.documentElement).getPropertyValue('--surface-mesh').trim(),
                names: [...document.querySelectorAll('[aria-label="Palette"] .fy-cc__title')].map(
                  node => node.textContent ?? '',
                ),
              };
            });
          const before = await read();
          const card = tab.locator(`[aria-label="Palette"] .fy-cc__card[data-choice="${palette}"]`);
          await card.scrollIntoViewIfNeeded();
          await card.click();
          await tab.waitForTimeout(500);
          const after = await read();
          expect(after.palette).toBe(palette);
          expect(after.accent).not.toBe(before.accent);
          expect(after.names).toContain(
            { mesh: 'Gradient mesh', aurora: 'Aurora', afterglow: 'Afterglow', briefing: 'Briefing' }[
              palette
            ] as string,
          );
          expect(after.mesh).toContain('radial-gradient');
          // The mesh is a LIST of glows, so it is several background layers: each one must be untiled (size auto, no-repeat). It was
          // tiled in the pattern's 32px squares (a pink checkerboard over the page) when the body's size and repeat lists were too short.
          const layers = await tab.evaluate(() => {
            const cs = getComputedStyle(document.body);
            const split = (value: string): string[] => {
              const parts: string[] = [];
              let depth = 0;
              let from = 0;
              for (let at = 0; at < value.length; at += 1) {
                const ch = value[at];
                if (ch === '(') depth += 1;
                else if (ch === ')') depth -= 1;
                else if (ch === ',' && depth === 0) {
                  parts.push(value.slice(from, at).trim());
                  from = at + 1;
                }
              }
              parts.push(value.slice(from).trim());
              return parts;
            };
            const sizes = split(cs.backgroundSize);
            const repeats = split(cs.backgroundRepeat);
            return split(cs.backgroundImage).map((image, index) => ({
              glow: /gradient\(/u.test(image),
              size: sizes[index % sizes.length] ?? '',
              repeat: repeats[index % repeats.length] ?? '',
            }));
          });
          const glows = layers.filter(layer => layer.glow);
          expect(glows.length, 'a mesh palette draws its glows').toBe(4);
          for (const glow of glows)
            expect(glow, 'an untiled glow').toEqual({ glow: true, size: 'auto', repeat: 'no-repeat' });
          await tab.evaluate(() => window.scrollTo(0, 0));
          await shot(tab, variant, `palette-${palette}`);
        } finally {
          await close();
        }
      });
});

/** C59 O6c: "try if it works properly here with all our themes": the page holds together in every style and every palette. */
describe('the Appearance page works in every style and every palette (C59 O6c)', () => {
  const probe = async (tab: Page) =>
    await tab.evaluate(() => {
      const slot = document.querySelector('.fy-sf-slot') as HTMLElement;
      const bounds = slot.getBoundingClientRect();
      const cut: string[] = [];
      for (const title of document.querySelectorAll<HTMLElement>('.fy-astep .fy-cc__title'))
        if (title.scrollWidth > title.clientWidth + 1) {
          const cs = getComputedStyle(title);
          cut.push(
            `${title.textContent ?? ''} (${title.scrollWidth}>${title.clientWidth}px, ${cs.fontSize} ${cs.fontFamily.split(',')[0]}, ls ${cs.letterSpacing}, pad ${cs.paddingInlineEnd})`,
          );
        }
      // A loud style may tilt or scale its picked card (Gen Z's sticker), so a card may lean a few px past the slot; more than 6px is a defect.
      const outside: string[] = [];
      let lean = 0;
      for (const card of document.querySelectorAll<HTMLElement>('.fy-astep .fy-cc__card')) {
        const box = card.getBoundingClientRect();
        const over = Math.max(box.right - bounds.right, bounds.left - box.left);
        lean = Math.max(lean, over);
        if (over > 6) outside.push(card.dataset.choice ?? '');
      }
      const selected = [...document.querySelectorAll('.fy-astep .fy-cc__card[data-selected="true"]')].length;
      const demo = document.querySelector('[data-appearance-demo]') as HTMLElement;
      const demoBox = demo.getBoundingClientRect();
      return {
        cut,
        outside,
        lean: Math.round(lean * 10) / 10,
        selected,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        demoInside: demoBox.left >= -1 && demoBox.right <= window.innerWidth + 1,
        demoPainted: [...demo.querySelectorAll('*')].filter(node => node.getBoundingClientRect().height > 0).length,
      };
    });
  for (const variant of [VARIANTS[0], VARIANTS[3]])
    it(`every one of the ${STYLES.length} styles keeps the cards, the sample and the page whole (${variant.name})`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        for (const style of STYLES) {
          const card = tab.locator(`[aria-label="Style"] .fy-cc__card[data-choice="${style.id}"]`);
          await card.scrollIntoViewIfNeeded();
          await card.click();
          await tab.waitForTimeout(450); // past the pick's own pop (260ms at most), even on a loaded machine
          const seen = await probe(tab);
          expect(seen.cut, `${style.id}: a card title is cut`).toEqual([]);
          expect(seen.outside, `${style.id}: a card pokes outside the page by ${seen.lean}px`).toEqual([]);
          if (seen.lean > 0)
            console.log(`MEASURED ${variant.name} ${style.id}: a picked card leans ${seen.lean}px past the slot`);
          expect(seen.selected, `${style.id}: one card is selected in each of the five lists`).toBe(5);
          expect(seen.overflow, `${style.id}: horizontal overflow`).toBeLessThanOrEqual(0);
          expect(seen.demoInside, `${style.id}: the sample is on screen`).toBe(true);
          expect(seen.demoPainted, `${style.id}: the sample is drawn`).toBeGreaterThan(8);
        }
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  it('at the Larger text size the cards grow their columns and no name is cut or broken (390 light)', async () => {
    const { tab, close } = await open(VARIANTS[2]);
    try {
      await tab.locator('[aria-label="Text size"] .fy-cc__card[data-choice="larger"]').click();
      await tab.waitForTimeout(250);
      for (const style of ['studio', 'briefing', 'raw', 'pixel']) {
        const card = tab.locator(`[aria-label="Style"] .fy-cc__card[data-choice="${style}"]`);
        await card.scrollIntoViewIfNeeded();
        await card.click();
        await tab.waitForTimeout(450); // past the pick's own pop (260ms at most), even on a loaded machine
        const seen = await probe(tab);
        expect(seen.cut, `${style}: a card title is cut at Larger`).toEqual([]);
        expect(seen.overflow, `${style}: horizontal overflow at Larger`).toBeLessThanOrEqual(0);
      }
    } finally {
      await close();
    }
  });
  // C59 O8-7 review: the phone pins the sample to the top and the footer to the bottom, so a card a KEY scrolls into view must come to
  // rest between them, never under either (End and Home on a list, and Tab into the next list), at the smallest screen at Larger text.
  for (const scheme of ['light', 'dark'] as const)
    for (const height of [568, 480])
      it(`keeps the card a key moves to clear of the pinned sample and footer (320x${height} ${scheme}, Larger text)`, async () => {
        const { tab, close } = await open({ name: `320-${scheme}`, width: 320, height, phone: true, scheme });
        try {
          await tab.locator('[aria-label="Text size"] .fy-cc__card[data-choice="larger"]').click();
          await tab.waitForTimeout(250);
          const hidden = async (label: string): Promise<string[]> =>
            (
              await tab.evaluate(() => {
                const focused = document.activeElement as HTMLElement | null;
                const card = focused?.closest('label') ?? focused;
                if (card === null || card === undefined) return ['nothing is focused'];
                const rect = card.getBoundingClientRect();
                const demo = (document.querySelector('.fy-spf__demo') as HTMLElement).getBoundingClientRect();
                const footer = (document.querySelector('.fy-spf__footer') as HTMLElement).getBoundingClientRect();
                const found: string[] = [];
                // Fully visible: below the sample's bottom edge and above the footer's top edge.
                if (rect.top < demo.bottom - 0.5)
                  found.push(
                    `under the sample by ${Math.round(demo.bottom - rect.top)}px of ${Math.round(rect.height)}px`,
                  );
                if (rect.bottom > footer.top + 0.5)
                  found.push(
                    `under the footer by ${Math.round(rect.bottom - footer.top)}px of ${Math.round(rect.height)}px`,
                  );
                return found;
              })
            ).map(problem => `${label}: ${problem}`);
          for (const list of ['Style', 'Palette']) {
            await tab.locator(`[aria-label="${list}"] input:checked`).focus();
            await tab.keyboard.press('End');
            await tab.waitForTimeout(150);
            expect(await hidden(list), `${list}: after End`).toEqual([]);
            await tab.keyboard.press('Home');
            await tab.waitForTimeout(150);
            expect(await hidden(list), `${list}: after Home`).toEqual([]);
            for (let step = 0; step < 6; step += 1) {
              await tab.keyboard.press('ArrowDown');
              await tab.waitForTimeout(100);
              expect(await hidden(list), `${list}: after ArrowDown ${step + 1}`).toEqual([]);
            }
          }
          // Tab from the last Style card to the next list, and Shift+Tab back.
          await tab.locator('[aria-label="Style"] input:checked').focus();
          for (let step = 0; step < 4; step += 1) {
            await tab.keyboard.press('Tab');
            await tab.waitForTimeout(100);
            expect(await hidden('tab'), `after Tab ${step + 1}`).toEqual([]);
          }
          for (let step = 0; step < 3; step += 1) {
            await tab.keyboard.press('Shift+Tab');
            await tab.waitForTimeout(100);
            expect(await hidden('shift-tab'), `after Shift+Tab ${step + 1}`).toEqual([]);
          }
        } finally {
          await close();
        }
      });
  for (const variant of [VARIANTS[1], VARIANTS[2]])
    it(`every one of the ${PALETTES.length} palettes keeps the cards, the sample and the page whole (${variant.name})`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        for (const palette of PALETTES) {
          const card = tab.locator(`[aria-label="Palette"] .fy-cc__card[data-choice="${palette.id}"]`);
          await card.scrollIntoViewIfNeeded();
          await card.click();
          await tab.waitForTimeout(450); // past the pick's own pop (260ms at most), even on a loaded machine
          const seen = await probe(tab);
          expect(seen.cut, `${palette.id}: a card title is cut`).toEqual([]);
          expect(seen.outside, `${palette.id}: a card pokes outside the page`).toEqual([]);
          expect(seen.overflow, `${palette.id}: horizontal overflow`).toBeLessThanOrEqual(0);
          expect(seen.demoPainted, `${palette.id}: the sample is drawn`).toBeGreaterThan(8);
        }
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
});

describe("the Briefing style and palette match the owner's reference (C59 O6b)", () => {
  for (const variant of VARIANTS)
    it(`Poppins 600 headings over a Poppins 400 body, blue and pink on navy / lavender-grey (${variant.name})`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.locator('[aria-label="Style"] .fy-cc__card[data-choice="briefing"]').click();
        await tab.locator('[aria-label="Palette"] .fy-cc__card[data-choice="briefing"]').click();
        await tab.waitForTimeout(500);
        const read = await tab.evaluate(() => {
          const heading = document.querySelector('.fy-astep__name') as HTMLElement;
          const root = getComputedStyle(document.documentElement);
          const demoButton = document.querySelector('[data-appearance-demo] .fy-ad__button') as HTMLElement;
          return {
            style: document.documentElement.dataset.style,
            palette: document.documentElement.dataset.palette,
            mode: document.documentElement.dataset.mode,
            headingFamily: getComputedStyle(heading).fontFamily,
            headingWeight: getComputedStyle(heading).fontWeight,
            bodyFamily: getComputedStyle(document.body).fontFamily,
            bodyWeight: getComputedStyle(document.body).fontWeight,
            grain: getComputedStyle(document.body, '::after').opacity,
            bg: getComputedStyle(document.body).backgroundColor,
            accent: root.getPropertyValue('--accent').trim(),
            focus: root.getPropertyValue('--focus-color').trim(),
            mesh: root.getPropertyValue('--surface-mesh').trim(),
            radiusPanel: getComputedStyle(document.documentElement).getPropertyValue('--radius-panel').trim(),
            demoButtonColour: getComputedStyle(demoButton).backgroundColor,
          };
        });
        expect(read).toMatchObject({ style: 'briefing', palette: 'briefing' });
        expect(read.headingFamily).toMatch(/^Poppins/u);
        expect(read.headingWeight).toBe('600');
        expect(read.bodyFamily).toMatch(/^Poppins/u);
        expect(read.bodyWeight).toBe('400');
        expect(Number(read.grain), 'no paper grain').toBe(0);
        expect(read.radiusPanel).toBe('16px');
        // The reference's own colours: lavender-grey page / navy ground, a bright blue accent (the reference's #555FFF by day, held
        // at 4.5:1 as text; its #8A92FF at night) and hot-pink glows (#F91974) behind the page.
        expect(read.bg).toBe(variant.scheme === 'light' ? 'rgb(233, 235, 244)' : 'rgb(14, 18, 32)');
        expect(read.accent).toBe(variant.scheme === 'light' ? '#424cec' : '#9aa1ff');
        expect(read.focus).toBe(variant.scheme === 'light' ? '#424cec' : '#8a92ff');
        // The page carries the document's glows (blue and hot pink): four of them, drawn behind the page.
        expect(read.mesh.match(/radial-gradient\(/gu)?.length, 'four glows').toBe(4);
        await tab.evaluate(() => window.scrollTo(0, 0));
        await shot(tab, variant, 'briefing');
        console.log(`MEASURED briefing ${variant.name}: ${JSON.stringify(read)}`);
      } finally {
        await close();
      }
    });
});

describe('the onboarding Appearance step (r11 G2)', () => {
  for (const variant of VARIANTS)
    it(`draws the choices as a grid of small cards, puts the live demo beside them, and says little (${variant.name})`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'appearance');
        const seen = await measure(tab);
        // Small cards in a grid (C59 O6c): the style and palette lists (16 and 12 cards) hold several to a row, and no card is a
        // full-width bar: each is under 200px wide and 140px tall, and a card is under 45% of the slot's width.
        // Five lists in three groups, in the order a person decides them (C59 O6): Style; Colour = Palette + Light or dark; Size and motion.
        expect(seen.labels).toEqual(['Style', 'Palette', 'Light or dark', 'Text size', 'Motion']);
        // ...and the grouping itself: Light or dark sits inside Colour (with Palette), Motion inside Size and motion (with Text size).
        expect(seen.sections).toEqual([
          { heading: 'Style', labels: ['Style'] },
          { heading: 'Colour', labels: ['Palette', 'Light or dark'] },
          { heading: 'Size and motion', labels: ['Text size', 'Motion'] },
        ]);
        for (const group of seen.groups) {
          expect(group.layout).toBe('row');
          for (const card of group.cards) {
            expect(card.right - card.x, 'a small card, not a bar').toBeLessThan(200);
            expect(card.bottom - card.y, 'a small card').toBeLessThan(140);
          }
        }
        const [styleCards, paletteCards] = [seen.groups[0], seen.groups[1]] as [
          (typeof seen.groups)[number],
          (typeof seen.groups)[number],
        ];
        for (const group of [styleCards, paletteCards]) {
          const perRow = group.cards.filter(card => Math.abs(card.y - (group.cards[0] as Box).y) < 2).length;
          expect(perRow, 'several to a row').toBeGreaterThanOrEqual(variant.phone ? 2 : 3);
        }
        const shape = (group: (typeof seen.groups)[number]) =>
          `${group.cards.filter(card => Math.abs(card.y - (group.cards[0] as Box).y) < 2).length} per row, ${Math.round((group.cards[0] as Box).right - (group.cards[0] as Box).x)}x${Math.round((group.cards[0] as Box).bottom - (group.cards[0] as Box).y)}px`;
        console.log(`MEASURED ${variant.name} cards: style ${shape(styleCards)}; palette ${shape(paletteCards)}`);
        const firstCard = seen.groups[0]?.cards[0] as Box;
        // The demo is drawn and has something in it.
        expect(seen.demo).not.toBeNull();
        expect(seen.demoPainted).toBeGreaterThan(3);
        const demo = seen.demo as Box;
        if (variant.phone) expect(demo.bottom).toBeLessThanOrEqual(firstCard.y + 1);
        else {
          // Beside the choices: the demo starts to the right of every card.
          const rightmost = Math.max(...seen.groups.flatMap(group => group.cards.map(card => card.right)));
          expect(demo.x).toBeGreaterThanOrEqual(rightmost - 1);
          // ...and BESIDE them, not below: it starts above the bottom of the last card.
          const lowest = Math.max(...seen.groups.flatMap(group => group.cards.map(card => card.bottom)));
          expect(demo.y).toBeLessThan(lowest);
          expect(demo.bottom - demo.y).toBeGreaterThan(160);
        }
        if (shotsDir !== '')
          console.log(
            `MEASURED ${variant.name}: text=${seen.text.length} chars (limit ${TEXT_LIMIT}), cards=${seen.groups.map(group => group.cards.length).join('+')}, demo=${Math.round(demo.x)},${Math.round(demo.y)} ${Math.round(demo.right - demo.x)}x${Math.round(demo.bottom - demo.y)}, firstCard.right=${Math.round(firstCard.right)}, overflow=${seen.overflow}`,
          );
        // Short: the page's own words (not the card titles) stay under the limit.
        expect(seen.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
        expect(seen.overflow).toBeLessThanOrEqual(0);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

  it('a pick restyles the page and the demo at once, in one place (1280 light)', async () => {
    const variant = VARIANTS[0];
    const { tab, close } = await open(variant);
    try {
      const read = async () =>
        await tab.evaluate(() => {
          const demo = document.querySelector('[data-step-demo]') as HTMLElement;
          const accent = getComputedStyle(demo.querySelector('[data-appearance-demo-accent]') ?? demo).backgroundColor;
          return {
            palette: document.documentElement.dataset.palette ?? '',
            style: document.documentElement.dataset.style ?? '',
            mode: document.documentElement.dataset.mode ?? '',
            accent,
            checked: [...document.querySelectorAll<HTMLInputElement>('.fy-sf-slot input[type=radio]:checked')].map(
              input => input.value,
            ),
          };
        });
      const before = await read();
      await tab.locator('[aria-label="Palette"] .fy-cc__card[data-choice="vaporwave"]').click();
      await tab.waitForTimeout(300);
      const afterPalette = await read();
      expect(afterPalette.palette).toBe('vaporwave');
      expect(afterPalette.accent).not.toBe(before.accent);
      expect(afterPalette.checked).toContain('vaporwave');
      await tab.locator('[aria-label="Light or dark"] .fy-cc__card[data-choice="dark"]').click();
      await tab.waitForTimeout(300);
      expect((await read()).mode).toBe('dark');
      await tab.locator('[aria-label="Style"] .fy-cc__card[data-choice="neo"]').click();
      // Let the pick's pop finish, then keep the picture of the picked look (palette, then Dark, then the Neo style).
      await tab.waitForTimeout(800);
      await tab.evaluate(() => window.scrollTo(0, 0));
      await shot(tab, variant, 'picked-vaporwave-dark-neo');
      expect((await read()).style).toBe('neo');
      // The two controls the base step had stay and work: Text size scales the type, Motion is chosen.
      const scale = async () =>
        await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fy-text-scale').trim());
      const defaultScale = await scale();
      await tab.locator('[aria-label="Text size"] .fy-cc__card[data-choice="larger"]').click();
      await tab.waitForTimeout(200);
      expect(await scale()).not.toBe(defaultScale);
      await tab.locator('[aria-label="Motion"] .fy-cc__card[data-choice="reduced"]').click();
      await tab.waitForTimeout(200);
      expect(await tab.locator('[aria-label="Motion"] input:checked').getAttribute('value')).toBe('reduced');
    } finally {
      await close();
    }
  });

  // r11 T13: the "triple dots" the owner disliked were the Motion preview on the Appearance page; none may animate here either.
  it('draws no three animated dots on the page, in any picked style (1280 light)', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      for (const style of ['studio', 'neo', 'mission', 'pixel']) {
        await tab.locator(`[aria-label="Style"] .fy-cc__card[data-choice="${style}"]`).click();
        await tab.waitForTimeout(300);
        const probe = await tab.evaluate(() => {
          const found: string[] = [];
          for (const element of document.querySelectorAll('*')) {
            const kids = [...element.children];
            if (kids.length !== 3) continue;
            const names = kids.map(kid => getComputedStyle(kid).animationName);
            if (names[0] !== 'none' && names.every(name => name === names[0]))
              found.push(`${element.tagName}.${element.className}`);
          }
          return { found, dots: document.querySelectorAll('.fy-dap-dots').length };
        });
        expect(probe, style).toEqual({ found: [], dots: 0 });
      }
    } finally {
      await close();
    }
  });
});

/**
 * O9 item 2: on a phone the heading and the sample are ONE pinned strip (the frame's own pin layout, the one Voice uses), opaque and as
 * wide as the screen, with nothing of the option cards showing over, above or behind it at the top, halfway down and at the end, in the
 * Pixel art style the owner's walk used (its hard card shadows were the worst offender). At 1440 the sample stays beside the cards.
 */
describe('the pinned Appearance strip (O9)', () => {
  const WIDE = (scheme: 'light' | 'dark'): Variant => ({
    name: `1440-${scheme}`,
    width: 1_440,
    height: 900,
    phone: false,
    scheme,
  });
  for (const scheme of ['light', 'dark'] as const) {
    const phone = VARIANTS.find(v => v.phone && v.scheme === scheme) as Variant;
    for (const where of ['top', 'mid', 'bottom'] as const)
      it(`keeps nothing behind the pinned heading and sample (390 ${scheme}, scrolled to ${where})`, async () => {
        const { tab, close } = await open(phone);
        try {
          await tab.locator('[aria-label="Style"] .fy-cc__card[data-choice="pixel"]').click();
          await tab.waitForTimeout(450);
          const strip = await pinnedStrip(tab, where);
          await tab.waitForTimeout(150);
          expect(strip.scrollable, 'the page scrolls').toBeGreaterThan(200);
          expect(strip.opaque, 'the strip is opaque').toBe(true);
          expect(strip.pin.left, 'the strip starts at the screen edge').toBeLessThanOrEqual(0.5);
          expect(strip.pin.right, 'the strip runs to the other edge').toBeGreaterThanOrEqual(strip.screenWidth - 0.5);
          expect(strip.headingInside, 'the heading is inside the strip').toBe(true);
          expect(strip.behind, 'nothing of the page shows over the strip').toEqual([]);
          expect(strip.above, 'nothing of the page shows above the strip').toEqual([]);
          if (where !== 'top') expect(strip.pin.top, 'the strip is pinned at the top').toBeLessThanOrEqual(0.5);
          await shot(tab, phone, `pinned-${where}`);
        } finally {
          await close();
        }
      });
    it(`keeps the sample beside the cards and pinned (1440 ${scheme})`, async () => {
      const { tab, close } = await open(WIDE(scheme));
      try {
        const g = await tab.evaluate(() => {
          const demo = document.querySelector('.fy-spf__demo') as HTMLElement;
          const card = document.querySelector('.fy-cc__card') as HTMLElement;
          return {
            demoX: demo.getBoundingClientRect().x,
            cardRight: card.getBoundingClientRect().right,
            position: getComputedStyle(demo).position,
          };
        });
        expect(g.demoX).toBeGreaterThan(g.cardRight);
        expect(g.position).toBe('sticky');
        await shot(tab, WIDE(scheme), 'appearance');
      } finally {
        await close();
      }
    });
  }
});

/** O9 round 2: a wide screen under 560 px tall pins no sample (it scrolls away with the page); at 900 px tall it stays pinned. */
describe('the Appearance sample and the height guard (O9 round 2)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`does not pin the sample on a 559 px tall wide screen (${scheme})`, async () => {
      const variant: Variant = { name: '1440x559', width: 1_440, height: 559, phone: false, scheme };
      const { tab, close } = await open(variant);
      try {
        const scroll = await demoScroll(tab);
        expect(scroll.scrollable, 'the page scrolls').toBeGreaterThan(150);
        expect(scroll.position, 'the sample is not sticky').not.toBe('sticky');
        expect(scroll.topBefore - scroll.topAfter, 'the sample scrolls away with the page').toBeGreaterThan(
          scroll.moved - 2,
        );
        await shot(tab, variant, 'scrolled');
      } finally {
        await close();
      }
    });
    it(`keeps the sample pinned on a 900 px tall wide screen (${scheme})`, async () => {
      const variant: Variant = { name: '1440x900', width: 1_440, height: 900, phone: false, scheme };
      const { tab, close } = await open(variant);
      try {
        const scroll = await demoScroll(tab);
        expect(scroll.scrollable, 'the page scrolls').toBeGreaterThan(150);
        expect(scroll.position).toBe('sticky');
        expect(Math.abs(scroll.topAfter - 16), 'the sample stays 16 px from the top').toBeLessThanOrEqual(1);
        await shot(tab, variant, 'scrolled');
      } finally {
        await close();
      }
    });
  }
});
