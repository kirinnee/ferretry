/**
 * THE SPLIT CHANGED NO PIXEL. Before `styles/themes.css` was split into styles, palettes and a mode, each family was ONE
 * block per mode and a theme was `data-theme="<family>-<mode>"`. The captured resolution of every custom property under
 * that arrangement (`fixtures/theme-parity-snapshot.json`, taken from `themes.css` at 536f48bc9f, in Chromium, at 1280 and
 * at 390 wide) is the reference. r11 T1 retired the rows of the families that no longer exist (the six compact palettes
 * and the `contrast` style, now a palette) and keeps the four that do: Studio, Mission, Neo and Geist, each now
 * `style = the same name` + `palette = the family`; this suite resolves the new stylesheet in the real engine and requires:
 *
 *  - those styles × their own palette × both modes × both widths: EVERY token identical;
 *  - the three shadow tokens, the panel texture and Mission Control's ruled page field (`--body-wash`), which are now
 *    assembled from a style's geometry and a palette's colours, drawn identically (compared as the browser serialises
 *    them, ignoring a fully transparent layer).
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { readStyleFile, readThemeCss } from '../../src/testing/theme-css.ts';
import { STYLE_IDS } from '../../src/theme/catalog.ts';

setDefaultTimeout(60_000);

type Snapshot = Readonly<Record<string, Readonly<Record<string, string>>>>;
const snapshot = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/theme-parity-snapshot.json'), 'utf8'),
) as Snapshot;

const ASSEMBLED = ['--shadow-sm', '--shadow-md', '--shadow-lg'] as const;
const TEXTURE = '--panel-texture';
const FIELD = '--body-wash';

/** A fully transparent shadow layer draws nothing; the new styles carry some where the old blocks had fewer layers. */
const drawn = (value: string): string =>
  value
    .split(/,(?![^(]*\))/u)
    .map(layer => layer.trim())
    .filter(
      layer =>
        !/^(?:rgba\(0, 0, 0, 0\)|rgb\(0 0 0 \/ 0\)|transparent|linear-gradient\(rgba\(0, 0, 0, 0\) 0%)/u.test(layer),
    )
    .join(', ')
    // `C 0 1px` and `C 1px` stop at the same place: one hairline.
    .replace(/(rgba?\([^)]*\)) 0px, \1 1px/gu, '$1 1px');

const resolved = async (page: Page, family: string, mode: string, width: number, names: readonly string[]) => {
  await page.setViewportSize({ width, height: 800 });
  return await page.evaluate(
    ([style, palette, tone, tokens]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', style as string);
      root.setAttribute('data-palette', palette as string);
      root.setAttribute('data-mode', tone as string);
      const computed = getComputedStyle(root);
      const out: Record<string, string> = {};
      for (const name of tokens as readonly string[]) out[name] = computed.getPropertyValue(name).trim();
      return out;
    },
    [family, family, mode, names] as const,
  );
};

/** What the OLD value draws, run through the same engine: set on a probe, read back as the browser serialises it. */
const drawnOld = async (page: Page, shadows: Readonly<Record<string, string>>, texture: string, field: string) =>
  await page.evaluate(
    ([values, image, wash]) => {
      const probe = document.getElementById('probe') as HTMLElement;
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(values as Record<string, string>)) {
        probe.style.boxShadow = value;
        out[name] = getComputedStyle(probe).boxShadow;
      }
      probe.style.boxShadow = '';
      probe.style.backgroundImage = image as string;
      out['--panel-texture'] = getComputedStyle(probe).backgroundImage;
      probe.style.backgroundImage = wash as string;
      out['--body-wash'] = getComputedStyle(probe).backgroundImage;
      probe.style.backgroundImage = '';
      return out;
    },
    [shadows, texture, field] as const,
  );

const drawnNow = async (page: Page) =>
  await page.evaluate(() => {
    const probe = document.getElementById('probe') as HTMLElement;
    const out: Record<string, string> = {};
    for (const name of ['--shadow-sm', '--shadow-md', '--shadow-lg']) {
      probe.style.boxShadow = `var(${name})`;
      out[name] = getComputedStyle(probe).boxShadow;
    }
    probe.style.boxShadow = '';
    probe.style.backgroundImage = 'var(--panel-texture)';
    out['--panel-texture'] = getComputedStyle(probe).backgroundImage;
    probe.style.backgroundImage = 'var(--body-wash)';
    out['--body-wash'] = getComputedStyle(probe).backgroundImage;
    probe.style.backgroundImage = '';
    return out;
  });

let page: Page;
beforeAll(async () => {
  const browser = await sharedChromium();
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${readThemeCss()}</style></head><body><div id="probe"></div></body></html>`,
  );
}, 120_000);

/** Styles whose kit (r11 T5-T12) deliberately dropped the old gradient field and panel texture; each unit adds its own styles. */
const NO_GRADIENT_FIELD: ReadonlySet<string> = new Set(['mission', 'hud', 'lucid', 'retro', 'pixel']);

/** Styles whose kit (r11 T7, T11) moved the focus ring INSIDE the control: `--focus-offset` is no longer the captured outward 0 or 2px. */
const RING_INSIDE: ReadonlySet<string> = new Set(['neo', 'lucid', 'briefing']);

describe('every old family-mode resolves to the same tokens on the three axes', () => {
  for (const [key, was] of Object.entries(snapshot)) {
    const [width, theme] = key.split(':') as [string, string];
    const [family, mode] = theme.split('-') as [string, string];
    const real = (STYLE_IDS as readonly string[]).includes(family);
    it(`${theme} at ${width}px${real ? '' : ' (colours)'}`, async () => {
      const names = Object.keys(was);
      const now = await resolved(page, family, mode, Number(width), names);
      // `--shadow-ink` is Neo's hard-shadow ink: the text colour unless a palette sets its own (r10 T13), where it used to be
      // transparent. No other style draws it, so it is not held to the capture.
      const compared = names.filter(
        name =>
          !(ASSEMBLED as readonly string[]).includes(name) &&
          name !== TEXTURE &&
          name !== FIELD &&
          name !== '--shadow-ink' &&
          !(RING_INSIDE.has(family) && name === '--focus-offset'),
      );
      const different = compared
        .filter(name => now[name] !== was[name])
        .map(name => `${name}: ${was[name]} → ${now[name]}`);
      expect(different).toEqual([]);
      if (RING_INSIDE.has(family)) expect(now['--focus-offset']).toMatch(/^calc\(-1 \* /u);
      if (!real) return;
      const [before, after] = [
        await drawnOld(
          page,
          Object.fromEntries(ASSEMBLED.map(name => [name, was[name] ?? ''])),
          was[TEXTURE] ?? '',
          was[FIELD] ?? 'none',
        ),
        await drawnNow(page),
      ];
      for (const name of ASSEMBLED) expect(drawn(after[name] ?? '')).toBe(drawn(before[name] ?? ''));
      if (NO_GRADIENT_FIELD.has(family)) {
        // The owner's theme line (turn 4247, item 12): no gradient on any background. The style's kit (r11 T5-T12) replaced the
        // old gradient wash and panel texture with the style contract's pattern tile, so both draw nothing now.
        expect(after['--panel-texture']).toBe('none');
        expect(after[FIELD]).toBe('none');
        return;
      }
      expect(drawn(after['--panel-texture'] ?? '')).toBe(drawn(before['--panel-texture'] ?? ''));
      expect(drawn(after[FIELD] ?? '')).toBe(drawn(before[FIELD] ?? ''));
    });
  }
});

describe('the ruled page field is the Mission style’s geometry and a palette’s inks', () => {
  const field = async (style: string, palette: string, mode = 'light') =>
    await page.evaluate(
      ([styleId, paletteId, tone]) => {
        const root = document.documentElement;
        root.setAttribute('data-style', styleId as string);
        root.setAttribute('data-palette', paletteId as string);
        root.setAttribute('data-mode', tone as string);
        const probe = document.getElementById('probe') as HTMLElement;
        // r11 T6: the ruled field is the style contract's own pattern tile (`--bg-pattern`), not a wash; the tile's size is
        // `--bg-pattern-size`. Read both: the image, then the size after it.
        probe.style.backgroundImage = 'var(--bg-pattern)';
        const image = getComputedStyle(probe).backgroundImage;
        probe.style.backgroundImage = '';
        const size = getComputedStyle(root).getPropertyValue('--bg-pattern-size').trim();
        return image === 'none' ? image : `${image} @${size}`;
      },
      [style, palette, mode] as const,
    );

  it('keeps no geometry in the palette file', () => {
    expect(readStyleFile('palette/mission.css').replace(/\/\*[\s\S]*?\*\//gu, '')).not.toMatch(
      /gradient|\b(?:32|96)px\b/u,
    );
  });

  it('Mission style on another palette draws the grid tile at 32px, in that palette’s inks', async () => {
    const grid = await field('mission', 'studio');
    expect(grid).toContain('conic-gradient');
    expect(grid).toEndWith('@32px');
    // Mission's own ink is rgba(11, 82, 95, 0.075); Studio's is another colour entirely.
    expect(grid).not.toBe(await field('mission', 'mission'));
  });

  it('Mission palette under another style draws no grid at all', async () => {
    // (Geist draws its own grid tile since r11 T5 and Neo its own dot tile since r11 T7, so the styles read here are the ones whose field is still none.)
    for (const style of ['studio', 'raw']) expect(await field(style, 'mission')).toBe('none');
  });

  it('the swapped pair and the original pair differ only in the inks', async () => {
    const swapped = await field('mission', 'studio');
    const own = await field('mission', 'mission');
    const inks = /(?:rgba?|color)\([^)]*\)/gu;
    expect(own.replace(inks, 'C')).toBe(swapped.replace(inks, 'C'));
  });
});

describe('the shell page heading takes its weight from the style, and only Briefing and Neumorphism move it', () => {
  // `.fy-page h1` used to set no weight, so every style drew the initial 400 (Tailwind's reset makes an h1 inherit it).
  const headingWeight = async (style: string) =>
    await page.evaluate(
      ([styleId]) => {
        const root = document.documentElement;
        root.setAttribute('data-style', styleId as string);
        const heading = document.getElementById('shell-heading') as HTMLElement;
        return getComputedStyle(heading).fontWeight;
      },
      [style] as const,
    );

  beforeAll(async () => {
    await page.addStyleTag({ content: `h1 { font-weight: inherit; }\n${readStyleFile('shell.css')}` });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<section class="fy-page"><h1 id="shell-heading">Heading</h1></section>',
      );
    });
  });

  for (const style of STYLE_IDS.filter(id => id !== 'briefing' && id !== 'neumorphism'))
    it(`${style} keeps the heading weight it always had (400)`, async () => {
      expect(await headingWeight(style)).toBe('400');
    });

  it("Briefing draws it in its display weight (600, Poppins as the owner's reference does)", async () => {
    expect(await headingWeight('briefing')).toBe('600');
  });

  it('Neumorphism draws it heavy and round (800), its signature weight', async () => {
    expect(await headingWeight('neumorphism')).toBe('800');
  });
});
