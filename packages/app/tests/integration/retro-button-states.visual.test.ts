/**
 * RETRO DESKTOP BUTTON STATES, in the real engine: the bevel must never paint over the fill a shared hover or press declares.
 *
 * Retro draws its bevel as a background IMAGE, and an image paints over the background COLOUR the shared design system sets
 * on `:hover` (Danger's `--err-bg`, Ghost's `--surface-2`) and `:active` (`--surface-3`). In dark the bevel also out-ranked the
 * press rule, so a hovered Danger button was the resting face (1.009:1 in Studio, 1.027:1 in Hacker) and a press kept its
 * gradient. A computed colour cannot see that (it still says the fill changed), so each state is read two ways:
 *
 *  - the computed `background-image` is `none` in that state, and
 *  - a SCREENSHOT of the button is one flat fill from its top inner edge to its bottom one (a bevel is a vertical ramp).
 *
 * It runs for every palette, both modes and both widths. The shared system's own hover/press fills are subtle (Danger hover is
 * `--err-bg` on `--surface`, about 1.02 to 1.2:1 in every style), so this test does not set an absolute floor on them: it pins
 * that Retro lets them show, which is the whole of what the style could take away.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { PALETTES } from '../../src/theme/catalog.ts';
import { readCssWithImports, readThemeCss, themeStylesDir } from '../../src/testing/theme-css.ts';

setDefaultTimeout(120_000);

const MODES = ['light', 'dark'] as const;
const WIDTHS = [1_280, 390] as const;
/** Per-channel difference under which two reads of one flat fill are the same (antialiasing, colour-space rounding). */
const FLAT = 3;
/**
 * Set `RETRO_STATES_SHOTS_DIR=<dir>` to keep a screenshot of the button row in each state (rest, then each variant hovered and
 * pressed), for the palettes named in `RETRO_STATES_SHOTS_PALETTES` (comma list, default `studio,hacker`).
 */
const shotsDir = process.env.RETRO_STATES_SHOTS_DIR ?? '';
const shotsPalettes = (process.env.RETRO_STATES_SHOTS_PALETTES ?? 'studio,hacker').split(',');

/** The states whose fill the shared system declares and Retro must not cover. Primary hover is Retro's own flat fill. */
const STATES = [
  { name: 'danger hover', variant: 'danger', press: false },
  { name: 'ghost hover', variant: 'ghost', press: false },
  { name: 'primary hover', variant: 'primary', press: false },
  { name: 'default press', variant: 'default', press: true },
  { name: 'danger press', variant: 'danger', press: true },
  { name: 'ghost press', variant: 'ghost', press: true },
] as const;

const VARIANTS = ['default', 'primary', 'danger', 'ghost'] as const;
const MARKUP = VARIANTS.map(
  name => `<button class="kt-btn" id="${name}"${name === 'default' ? '' : ` data-variant="${name}"`}>Label</button>`,
).join('\n');

let page: Page;
beforeAll(async () => {
  const browser = await sharedChromium();
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  page = await context.newPage();
  const design = readCssWithImports(join(themeStylesDir, '../ui/design-system.css'));
  await page.setContent(
    `<!doctype html><html data-style="retro" data-palette="studio" data-mode="light"><head><style>${readThemeCss()}\n${design}
body{margin:0;padding:24px;background:var(--bg);display:flex;gap:32px;flex-wrap:wrap}</style></head><body>${MARKUP}</body></html>`,
  );
}, 120_000);

afterAll(async () => {
  await page.context().close();
});

/** The painted fill just inside the top edge and just inside the bottom edge of a button, read from a screenshot. */
async function paintedEnds(variant: string): Promise<{ top: number[]; bottom: number[] }> {
  const box = await page.locator(`#${variant}`).boundingBox();
  if (box === null) throw new Error(`no box for ${variant}`);
  const png = (await page.screenshot({ clip: box, scale: 'css', type: 'png' })).toString('base64');
  return page.evaluate(
    async ({ data, height }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      // The left padding (clear of the glyphs), a few pixels inside the border at each end.
      return { top: at(7, 5), bottom: at(7, height - 6) };
    },
    { data: png, height: box.height },
  );
}

/** The button row at 2x, kept under `shotsDir`. */
async function shoot(name: string): Promise<void> {
  await page.waitForTimeout(250); // the shared 120ms colour transition has settled
  await mkdir(shotsDir, { recursive: true });
  const row = await page.locator('body').boundingBox();
  if (row === null) return;
  await page.screenshot({
    path: join(shotsDir, `${name}.png`),
    clip: { x: 0, y: 0, width: Math.min(row.width, 640), height: 140 },
    scale: 'css',
  });
}

for (const width of WIDTHS) {
  describe(`retro button hover and press at ${width}`, () => {
    for (const mode of MODES) {
      for (const palette of PALETTES) {
        it(`${palette.id} ${mode}: no bevel over a hover or press fill`, async () => {
          await page.setViewportSize({ width, height: 600 });
          await page.evaluate(
            ({ tone, tint }) => {
              document.documentElement.setAttribute('data-mode', tone);
              document.documentElement.setAttribute('data-palette', tint);
            },
            { tone: mode, tint: palette.id },
          );
          const report: string[] = [];
          const keep = shotsDir !== '' && shotsPalettes.includes(palette.id);
          if (keep) await shoot(`${width}-${mode}-${palette.id}-rest`);
          for (const state of STATES) {
            await page.mouse.move(0, 0);
            await page.locator(`#${state.variant}`).hover();
            if (state.press) await page.mouse.down();
            const image = await page.locator(`#${state.variant}`).evaluate(el => getComputedStyle(el).backgroundImage);
            const { top, bottom } = await paintedEnds(state.variant);
            if (keep) await shoot(`${width}-${mode}-${palette.id}-${state.name.replace(' ', '-')}`);
            if (state.press) await page.mouse.up();
            await page.mouse.move(0, 0);
            if (image !== 'none') report.push(`${state.name}: background-image ${image}`);
            if (top.some((value, i) => Math.abs(value - (bottom[i] as number)) > FLAT)) {
              report.push(`${state.name}: not flat, top rgb(${top}) vs bottom rgb(${bottom})`);
            }
          }
          expect(report).toEqual([]);
        });
      }
    }
  });
}
