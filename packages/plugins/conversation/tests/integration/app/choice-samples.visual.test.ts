/**
 * THE SETTINGS CHOICE SAMPLES in a real browser over fake data (`fixtures/choice-samples-scene.tsx`): every card of the
 * Editor style and Button layout rows holds a picture of what it does, drawn in a fixed-shape box, so choosing a card (and
 * Auto's one movement) moves nothing around it, the Button layout pictures are laid out by the real composer stylesheet, and
 * nothing runs under reduced motion.
 *
 * Set `FY_CHOICE_SAMPLES_SHOTS_DIR` to keep `<viewport>-<scheme>-<row>.png` (1440 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CHOICE_SAMPLES_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-choice-samples-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/choice-samples-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the choice samples scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1440', width: 1_440, height: 900, phone: false },
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
  await tab.waitForSelector('[data-choice-sample]');
  return { tab, problems, close: async () => await context.close() };
};

const ROWS = ['Style', 'Button layout'] as const;
const rowOf = (tab: Page, name: (typeof ROWS)[number]) => tab.locator(`[data-setting-row="${name}"]`);

/** The shape of every sample box in a row, and where the row's own box and the page's height are. */
const measure = async (tab: Page, name: (typeof ROWS)[number]) =>
  await rowOf(tab, name).evaluate(row => ({
    row: Math.round(row.getBoundingClientRect().height),
    page: document.documentElement.scrollHeight,
    scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    boxes: [...row.querySelectorAll('[data-choice-sample]')].map(box => {
      const { width, height } = box.getBoundingClientRect();
      return { width: Math.round(width), height: Math.round(height) };
    }),
    cards: [...row.querySelectorAll('.fy-cc__card')].map(card => Math.round(card.getBoundingClientRect().height)),
  }));

describe('Settings choice samples', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: every card has a sample of the same fixed shape, and the cards are level`, async () => {
        const { tab, problems, close } = await open(viewport, scheme);
        try {
          for (const name of ROWS) {
            const state = await measure(tab, name);
            expect(state.boxes.length, `${name}: one sample per card`).toBe(3);
            expect(new Set(state.boxes.map(box => `${box.width}x${box.height}`)).size, `${name}: one shape`).toBe(1);
            expect(state.boxes[0]?.height ?? 0, `${name}: drawn, not collapsed`).toBeGreaterThan(40);
            expect(state.scrollX, `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
            if (!viewport.phone) expect(new Set(state.cards).size, `${name}: cards level`).toBe(1);
            if (shotsDir !== '')
              await rowOf(tab, name).screenshot({
                path: join(shotsDir, `${viewport.name}-${scheme}-${name.toLowerCase().replace(' ', '-')}.png`),
              });
          }
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: choosing a card, and Auto's one movement, move nothing around the samples`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          for (const name of ROWS) {
            const before = await measure(tab, name);
            for (const value of name === 'Style' ? ['off', 'rich', 'on'] : ['stacked', 'auto', 'row']) {
              await rowOf(tab, name).locator(`input[value="${value}"]`).locator('xpath=ancestor::label').click();
              // Mid-movement for Auto (it is 0.9s), then settled: the geometry is the same at both moments.
              for (const wait of [300, 1_200]) {
                await tab.waitForTimeout(wait);
                const now = await measure(tab, name);
                expect(now.row, `${name} ${value}: row height`).toBe(before.row);
                expect(now.page, `${name} ${value}: page height`).toBe(before.page);
                expect(now.boxes, `${name} ${value}: sample boxes`).toEqual(before.boxes);
                expect(now.cards, `${name} ${value}: card heights`).toEqual(before.cards);
              }
            }
          }
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: the Button layout pictures are laid out by the real composer stylesheet`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          const layout = async (value: string) =>
            await rowOf(tab, 'Button layout')
              .locator(`[data-choice="${value}"] [data-dock-sample] .fy-composer-dock`)
              .first()
              .evaluate(dock => ({
                direction: getComputedStyle(dock).flexDirection,
                slot: getComputedStyle(dock.parentElement?.querySelector('.fy-composer-slot') as Element).display,
              }));
          expect((await layout('stacked')).direction).toBe('column');
          expect((await layout('row')).direction).toBe('row');
          expect((await layout('auto')).direction, 'Auto draws its empty, side by side look first').toBe('row');
          const autoDirections = await rowOf(tab, 'Button layout')
            .locator('[data-dock-sample="auto"] .fy-composer-dock[data-composer-dock="start"]')
            .evaluateAll(docks => docks.map(dock => getComputedStyle(dock).flexDirection));
          expect(autoDirections, 'Auto: side by side while empty, then stacked once typed').toEqual(['row', 'column']);
          expect((await layout('stacked')).slot, 'stacked keeps the interrupt place').toBe('block');
          expect((await layout('row')).slot, 'one row holds no empty place').toBe('none');
          // The sample's own pictures differ: the stacked composer is taller than the one-row composer.
          const heights = await rowOf(tab, 'Button layout')
            .locator('[data-dock-sample="stacked"] .fy-composer, [data-dock-sample="row"] .fy-composer')
            .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
          expect(heights[0] ?? 0).toBeGreaterThan(heights[1] ?? 0);
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: with motion reduced nothing runs and a chosen card still shows its picture`, async () => {
        const { tab, close } = await open(viewport, scheme, '&motion=reduced');
        try {
          await rowOf(tab, 'Button layout').locator('input[value="auto"]').locator('xpath=ancestor::label').click();
          await rowOf(tab, 'Style').locator('input[value="rich"]').locator('xpath=ancestor::label').click();
          await tab.waitForTimeout(300);
          expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
          expect(await tab.locator('[data-choice-sample]').count()).toBe(6);
          expect(await tab.locator('[data-pulse="true"]').count(), 'no pulse is armed').toBe(0);
          const opacity = await tab
            .locator('[data-dock-sample="auto"] .fy-dls__half--typed')
            .evaluate(half => getComputedStyle(half).opacity);
          expect(opacity, 'Auto shows both of its pictures').toBe('1');
        } finally {
          await close();
        }
      });
    }

  it('Auto plays one movement when chosen, the typed picture arriving, and ends where it began', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'light');
    try {
      const typed = tab.locator('[data-dock-sample="auto"] .fy-dls__half--typed');
      const opacity = async () => Number(await typed.evaluate(half => getComputedStyle(half).opacity));
      expect(await opacity()).toBe(1);
      await rowOf(tab, 'Button layout').locator('input[value="auto"]').locator('xpath=ancestor::label').click();
      await tab.waitForTimeout(80);
      expect(await opacity(), 'the picture is arriving').toBeLessThan(0.9);
      await tab.waitForTimeout(1_200);
      expect(await opacity(), 'back at rest').toBe(1);
      expect(await tab.evaluate(() => document.getAnimations().length), 'nothing keeps running').toBe(0);
    } finally {
      await close();
    }
  });
});
