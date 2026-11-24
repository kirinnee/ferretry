/**
 * THE PRIMARY BUTTON READS in every look (O11 R9). The owner's walk saw "+ New ferret" and "Add a login" as pale lavender
 * with unreadable text in dark mode. The label of a filled control sits on the accent fill, so the fill and its label
 * (`--accent` / `--accent-fg`, and `--accent-strong` under the pointer) must clear WCAG AA 4.5:1 for EVERY palette, in EVERY
 * style, in BOTH modes — measured on the real button the real app draws (the "Add a login" button on New ferret), not on a
 * copy of the token values, so a style that repaints the button is caught too.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';
import { COLOUR_TOOLS, type ColourTools } from '../support/browser/colour.ts';
import { PALETTES, STYLES } from '../../src/theme/catalog.ts';

setDefaultTimeout(240_000);

const appScene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;
let browser: Browser;
let server: { kill: () => void } | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  const child = Bun.spawn([process.execPath, sceneServer, '--entry', appScene], { stderr: 'inherit', stdout: 'pipe' });
  server = child;
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
}, 200_000);

afterAll(() => server?.kill());

describe('the primary button', () => {
  for (const mode of ['light', 'dark'] as const)
    it(`keeps its label at 4.5:1 on its fill in ${mode} for every style and palette, at rest and under the pointer`, async () => {
      const context = await browser.newContext({
        viewport: { width: 1_440, height: 900 },
        colorScheme: mode,
        reducedMotion: 'reduce',
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(30_000);
      try {
        await tab.goto(`${origin}/d/ws/new?noRuntimes=1&style=studio&palette=studio&mode=${mode}`);
        const button = tab.getByRole('button', { name: 'Add a login' });
        await button.waitFor();
        await tab.evaluate(COLOUR_TOOLS);
        // The shell's own transitions would hand back a half-way colour under the pointer.
        await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
        const misses: string[] = [];
        let measured = 0;
        for (const style of STYLES)
          for (const palette of PALETTES) {
            await tab.evaluate(
              ({ style, palette, mode }) => {
                const root = document.documentElement;
                root.setAttribute('data-style', style);
                root.setAttribute('data-palette', palette);
                root.setAttribute('data-mode', mode);
              },
              { style: style.id, palette: palette.id, mode },
            );
            for (const state of ['rest', 'hover'] as const) {
              if (state === 'hover') await button.hover();
              else await tab.mouse.move(0, 0);
              const ratio = await button.evaluate((element: HTMLElement) => {
                const { backdrop, over, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
                const css = getComputedStyle(element);
                const fill = rgba(css.backgroundColor);
                const ground = backdrop(element.parentElement ?? element);
                const paint = over(fill, [...ground, 1]);
                const ink = rgba(css.color);
                return ratio(over([ink[0], ink[1], ink[2], ink[3]], [...paint, 1]), paint);
              });
              measured += 1;
              if (ratio < 4.5)
                misses.push(
                  `${style.id} × ${palette.id} ${mode} ${state}: ${ratio.toFixed(2)}:1${style.loud ? ' (loud)' : ''}`,
                );
            }
          }
        expect(measured, 'every style × palette × state was measured').toBe(STYLES.length * PALETTES.length * 2);
        expect(misses).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
