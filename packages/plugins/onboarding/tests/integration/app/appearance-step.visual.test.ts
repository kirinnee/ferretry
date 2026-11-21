/**
 * THE ONBOARDING APPEARANCE STEP (r11 G2, owner line 3) in a real browser over fake data (`fixtures/appearance-step-scene.tsx`):
 * the choices are STACKED cards (one column, one above the next), the live theme demo sits to the RIGHT of them at 1280 and above
 * them at 390, the page text (the slot's text minus the card titles) is at most 160 characters, and a pick restyles the page and
 * the demo at once.
 *
 * Set `FY_APPEARANCE_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

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
type Variant = (typeof VARIANTS)[number];

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
    const clone = slot.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll('.fy-cc__title, .sr-only, [aria-hidden="true"]')) hidden.remove();
    const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    const demo = document.querySelector('[data-step-demo]') as HTMLElement | null;
    const painted =
      demo === null ? [] : [...demo.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0);
    return {
      groups,
      text,
      demo: demo === null ? null : box(demo),
      demoPainted: painted.length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

describe('the onboarding Appearance step (r11 G2)', () => {
  for (const variant of VARIANTS)
    it(`stacks the choices, puts the live demo beside them, and says little (${variant.name})`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'appearance');
        const seen = await measure(tab);
        // Stacked: every group is the stack layout, and each card sits under the one before it, in one column.
        expect(seen.groups.length).toBeGreaterThanOrEqual(3);
        for (const group of seen.groups) {
          expect(group.layout).toBe('stack');
          for (let index = 1; index < group.cards.length; index += 1) {
            const above = group.cards[index - 1] as Box;
            const card = group.cards[index] as Box;
            expect(Math.abs(card.x - above.x)).toBeLessThan(1);
            expect(card.y).toBeGreaterThanOrEqual(above.bottom - 1);
          }
        }
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
      await tab.locator('[aria-label="Colour mode"] .fy-cc__card[data-choice="dark"]').click();
      await tab.waitForTimeout(300);
      expect((await read()).mode).toBe('dark');
      await tab.locator('[aria-label="Style"] .fy-cc__card[data-choice="neo"]').click();
      await shot(tab, variant, 'picked');
      expect((await read()).style).toBe('neo');
    } finally {
      await close();
    }
  });
});
