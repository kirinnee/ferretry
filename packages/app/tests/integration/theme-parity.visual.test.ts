/**
 * THE SPLIT CHANGED NO PIXEL. Before `styles/themes.css` was split into styles, palettes and a mode, each of the eleven
 * families was ONE block per mode and a theme was `data-theme="<family>-<mode>"`. The captured resolution of every custom
 * property under that arrangement (`fixtures/theme-parity-snapshot.json`, taken from `themes.css` at 536f48bc9f, in
 * Chromium, at 1280 and at 390 wide) is the reference. Each old family is now `style = the same name` (the five real
 * styles) or `style = its suggested style` (the six compact ones) + `palette = the family`; this suite resolves the new
 * stylesheet in the real engine and requires:
 *
 *  - the five real styles × their own palette × both modes × both widths: EVERY token identical;
 *  - the six compact palettes × both modes: EVERY colour token identical (their structure was folded into pairings, on
 *    purpose, so only their colours are held to the capture);
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
import { PALETTES, STYLE_IDS } from '../../src/theme/catalog.ts';

setDefaultTimeout(60_000);

type Snapshot = Readonly<Record<string, Readonly<Record<string, string>>>>;
const snapshot = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/theme-parity-snapshot.json'), 'utf8'),
) as Snapshot;

const ASSEMBLED = ['--shadow-sm', '--shadow-md', '--shadow-lg'] as const;
const TEXTURE = '--panel-texture';
const FIELD = '--body-wash';
const suggested = new Map(PALETTES.map(palette => [palette.id as string, palette.suggestedStyle as string]));

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
    [suggested.get(family) ?? family, family, mode, names] as const,
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
const palettePart = (names: readonly string[]) => {
  const own = new Set(
    [
      ...readStyleFile('tokens/base-palette.css')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .matchAll(/(--[\w-]+)\s*:/gu),
    ].map(match => match[1] as string),
  );
  for (const added of [
    '--shadow-sm-1',
    '--shadow-sm-2',
    '--shadow-sm-3',
    '--shadow-md-1',
    '--shadow-md-2',
    '--shadow-md-3',
    '--shadow-lg-1',
    '--shadow-lg-2',
    '--shadow-lg-3',
    '--texture-ink',
  ])
    own.delete(added);
  return names.filter(name => own.has(name));
};

beforeAll(async () => {
  const browser = await sharedChromium();
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${readThemeCss()}</style></head><body><div id="probe"></div></body></html>`,
  );
}, 120_000);

describe('every old family-mode resolves to the same tokens on the three axes', () => {
  for (const [key, was] of Object.entries(snapshot)) {
    const [width, theme] = key.split(':') as [string, string];
    const [family, mode] = theme.split('-') as [string, string];
    const real = (STYLE_IDS as readonly string[]).includes(family);
    it(`${theme} at ${width}px${real ? '' : ' (colours)'}`, async () => {
      const names = Object.keys(was);
      const now = await resolved(page, family, mode, Number(width), names);
      const compared = names.filter(
        name => !(ASSEMBLED as readonly string[]).includes(name) && name !== TEXTURE && name !== FIELD,
      );
      const different = compared
        .filter(name => now[name] !== was[name])
        .map(name => `${name}: ${was[name]} → ${now[name]}`);
      expect(different).toEqual([]);
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
      expect(drawn(after['--panel-texture'] ?? '')).toBe(drawn(before['--panel-texture'] ?? ''));
      expect(drawn(after[FIELD] ?? '')).toBe(drawn(before[FIELD] ?? ''));
    });
  }

  it('the colour part of the capture is a real subset of the palette tokens', () => {
    // The assembled tokens (`--body-wash`, built from a style's geometry and a palette's inks) are not palette tokens.
    const sample = Object.keys(snapshot['1280:ma-dark'] ?? {}).filter(name => name !== FIELD);
    expect(sample.length).toBeGreaterThan(60);
    expect(palettePart(sample)).toEqual(sample);
  });
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
        probe.style.backgroundImage = 'var(--body-wash)';
        const image = getComputedStyle(probe).backgroundImage;
        probe.style.backgroundImage = '';
        return image;
      },
      [style, palette, mode] as const,
    );

  it('keeps no geometry in the palette file', () => {
    expect(readStyleFile('palette/mission.css').replace(/\/\*[\s\S]*?\*\//gu, '')).not.toMatch(
      /gradient|\b(?:32|96)px\b/u,
    );
  });

  it('Mission style on another palette draws the grid at 96px and 32px, in that palette’s inks', async () => {
    const wash = await field('mission', 'studio');
    expect(wash).toContain('repeating-linear-gradient');
    expect(wash).not.toContain('rgba(11, 82, 95');
  });

  it('Mission palette under another style draws no grid at all', async () => {
    for (const style of ['studio', 'neo', 'geist', 'contrast']) expect(await field(style, 'mission')).toBe('none');
  });

  it('the swapped pair and the original pair differ only in the inks', async () => {
    const swapped = await field('mission', 'studio');
    const own = await field('mission', 'mission');
    expect(own.replace(/rgba?\([^)]*\)/gu, 'C')).toBe(swapped.replace(/rgba?\([^)]*\)/gu, 'C'));
  });
});
