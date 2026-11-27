/**
 * THE RENDERER CONTRACT, HELD TO EVERY THEME (`src/theme/render-contract.ts`). For every style × palette × mode this resolves the
 * token map the browser would build, with no browser (`tests/support/theme-tokens.ts`), and checks the promise a renderer relies on:
 *
 *  - every `RENDER_PALETTE_TOKENS` and `RENDER_STYLE_TOKENS` entry resolves to a value: nothing dangling, no cycle, every chain
 *    ends in a literal within 8 hops;
 *  - every keyword slot a stylesheet cannot branch on is one of its allowed words;
 *  - every `renderContrastPairs` pair meets its floor (text 4.5:1, chart marks 3:1, and on High contrast body text 7:1).
 *
 * A miss names the file, the token or pair and the measured ratio. A miss that exists today and is not this test's to fix is
 * PINNED in `KNOWN` by its exact identity with the reason, and the observed set is compared with the pinned set BOTH ways: a miss
 * nobody pinned fails, and a pin whose miss is gone fails, so the ledger neither grows silently nor goes stale.
 *
 * Size: 16 styles × 12 palettes × 2 modes = 384 combinations resolve 95 tokens each, and 24 palette × mode pairs are measured
 * (a style never changes a colour, so a ratio is a property of the palette and the mode).
 */
import { describe, expect, it } from 'bun:test';
import {
  RENDER_KEYWORD_SLOTS,
  RENDER_PALETTE_TOKENS,
  RENDER_STYLE_TOKENS,
  renderContrastPairs,
} from '../../src/theme/render-contract.ts';
import { THEME_TOKENS } from '../../src/fy-render/palette.ts';
import { PALETTES, STYLES } from '../../src/theme/catalog.ts';
import { readStyleFile } from '../../src/testing/theme-css.ts';
import {
  MAX_HOPS,
  ratioOf,
  resolveColour,
  resolveToken,
  tokenMap,
  type ThemeMode,
  type ThemeSources,
} from '../support/theme-tokens.ts';

const MODES: readonly ThemeMode[] = ['light', 'dark'];
const HIGH_CONTRAST = 'contrast';

const baseStyle = readStyleFile('tokens/base-style.css');
const basePalette = readStyleFile('tokens/base-palette.css');
const sourcesOf = (style: string, palette: string): ThemeSources => ({
  baseStyle,
  basePalette,
  palette: readStyleFile(`palette/${palette}.css`),
  style: readStyleFile(`style/${style}.css`),
});

/** Every miss of one combination, each as `path | what | got`. */
function problems(sources: ThemeSources, style: string, palette: string, mode: ThemeMode): readonly string[] {
  const out: string[] = [];
  const map = tokenMap(sources, { mode, palette, style });
  const at = `styles/style/${style}.css × styles/palette/${palette}.css × ${mode}`;
  for (const token of [...RENDER_PALETTE_TOKENS, ...RENDER_STYLE_TOKENS]) {
    const resolved = resolveToken(map, token);
    if (!resolved.ok) out.push(`${at} | ${token} | ${resolved.reason}`);
  }
  for (const [slot, allowed] of Object.entries(RENDER_KEYWORD_SLOTS)) {
    const resolved = resolveToken(map, slot);
    if (!resolved.ok) out.push(`${at} | ${slot} | ${resolved.reason}`);
    else if (!(allowed as readonly string[]).includes(resolved.value))
      out.push(`${at} | ${slot} | "${resolved.value}" is not one of ${allowed.join(', ')}`);
  }
  return out;
}

/** Every contrast miss of one palette × mode, each as `path | ink on ground | ratio`. */
function contrastMisses(sources: ThemeSources, palette: string, mode: ThemeMode): readonly string[] {
  const out: string[] = [];
  const map = tokenMap(sources, { mode, palette, style: 'studio' });
  const at = `styles/palette/${palette}.css × ${mode}`;
  const page = resolveColour(map, 'bg');
  for (const pair of renderContrastPairs(palette === HIGH_CONTRAST)) {
    const ink = resolveColour(map, pair.ink);
    const ground = resolveColour(map, pair.ground);
    if (!ink.ok || !ground.ok || !page.ok) continue; // an unresolved token is reported by `problems`
    const ratio = ratioOf(ink.colour, ground.colour, page.colour);
    if (ratio < pair.floor)
      out.push(`${at} | ${pair.ink} on ${pair.ground} | ${ratio.toFixed(2)}:1, needs ${pair.floor}:1`);
  }
  return out;
}

/** Misses that exist on base and are pinned, `identity -> why`. Empty means the contract holds today. */
const KNOWN: Readonly<Record<string, string>> = {};

describe('the resolver', () => {
  const sources = (palette: string, style = ''): ThemeSources => ({ baseStyle: '', basePalette: '', palette, style });
  const choice = { mode: 'dark', palette: 'p', style: 's' } as const;

  it('layers a mode block over its palette block over the base, whatever the file order', () => {
    const map = tokenMap(
      {
        baseStyle: '',
        basePalette: ':root, [data-swatch] { --bg: #ffffff; --fg: #000000; }',
        palette: [
          ":root[data-palette='p'][data-mode='dark'], [data-swatch][data-palette='p'][data-mode='dark'] { --bg: #111111; }",
          ":root[data-palette='p'], [data-swatch][data-palette='p'] { --bg: #222222; --fg: #eeeeee; }",
          ":root[data-palette='q'] { --fg: #123456; }",
        ].join('\n'),
        style: "@media (max-width: 640px) { :root[data-style='s'] { --fg: #abcdef; } }",
      },
      choice,
    );
    expect(map.get('bg')).toBe('#111111');
    expect(map.get('fg')).toBe('#eeeeee');
  });

  it('follows var() chains, fallbacks and rgb(var(--channels) / alpha) to a colour', () => {
    const map = tokenMap(
      sources(
        ":root[data-palette='p'] { --a: var(--b); --b: var(--missing, #336699); --rgb: 10 20 30; --c: rgb(var(--rgb) / 0.5); }",
      ),
      choice,
    );
    expect(resolveToken(map, 'a')).toEqual({ ok: true, value: '#336699' });
    expect(resolveColour(map, 'c')).toEqual({ colour: { a: 0.5, b: 30, g: 20, r: 10 }, ok: true });
  });

  it('mixes in sRGB, with the share of the second colour defaulting to the rest', () => {
    const map = tokenMap(
      sources(
        ":root[data-palette='p'] { --m: color-mix(in srgb, #000000, #ffffff); --n: color-mix(in srgb, #000000 25%, #ffffff); }",
      ),
      choice,
    );
    expect(resolveColour(map, 'm')).toEqual({ colour: { a: 1, b: 127.5, g: 127.5, r: 127.5 }, ok: true });
    expect(resolveColour(map, 'n')).toEqual({ colour: { a: 1, b: 191.25, g: 191.25, r: 191.25 }, ok: true });
  });

  it('refuses a dangling var(), a cycle and a chain over the hop limit, naming the token', () => {
    const chain = Array.from({ length: MAX_HOPS + 2 }, (_, i) => `--h${i}: var(--h${i + 1});`).join(' ');
    const map = tokenMap(
      sources(
        `:root[data-palette='p'] { --dangling: var(--nowhere); --x: var(--y); --y: var(--x); ${chain} --h${MAX_HOPS + 2}: #fff; }`,
      ),
      choice,
    );
    expect(resolveToken(map, 'dangling')).toMatchObject({ ok: false, reason: expect.stringContaining('--nowhere') });
    expect(resolveToken(map, 'x')).toMatchObject({ ok: false, reason: expect.stringContaining('cycle') });
    expect(resolveToken(map, 'h0')).toMatchObject({ ok: false, reason: expect.stringContaining('hops') });
    expect(resolveToken(map, 'unset')).toMatchObject({ ok: false });
  });
});

describe('the contract lists', () => {
  it('name every token once, and every token is declared by a base file', () => {
    const all = [...RENDER_PALETTE_TOKENS, ...RENDER_STYLE_TOKENS];
    expect(new Set(all).size).toBe(all.length);
    const declared = (css: string): Set<string> =>
      new Set(
        [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/(--[\w-]+)\s*:/gu)].map(match =>
          (match[1] as string).slice(2),
        ),
      );
    expect(RENDER_PALETTE_TOKENS.filter(token => !declared(basePalette).has(token))).toEqual([]);
    expect(RENDER_STYLE_TOKENS.filter(token => !declared(baseStyle).has(token))).toEqual([]);
  });

  it('cover every token an illustration (a chart, a diagram) reads', () => {
    expect(THEME_TOKENS.filter(token => !(RENDER_PALETTE_TOKENS as readonly string[]).includes(token))).toEqual([]);
  });
});

describe('every style × palette × mode resolves the contract', () => {
  const observed: string[] = [];
  for (const style of STYLES)
    for (const palette of PALETTES)
      for (const mode of MODES) observed.push(...problems(sourcesOf(style.id, palette.id), style.id, palette.id, mode));

  it('has the combinations it is measuring', () => {
    expect(STYLES.length * PALETTES.length * MODES.length).toBeGreaterThanOrEqual(384);
  });

  it('leaves no token dangling and no keyword outside its set', () => {
    expect(observed.filter(line => !(line in KNOWN))).toEqual([]);
  });
});

describe('every palette × mode meets the contract contrast', () => {
  const observed: string[] = [];
  for (const palette of PALETTES)
    for (const mode of MODES) observed.push(...contrastMisses(sourcesOf('studio', palette.id), palette.id, mode));

  it('has no miss that is not pinned', () => {
    expect(observed.filter(line => !(line in KNOWN))).toEqual([]);
  });

  it('pins nothing that no longer misses', () => {
    const seen = new Set([...observed]);
    expect(Object.keys(KNOWN).filter(key => !seen.has(key))).toEqual([]);
  });
});

describe('a removed token fails, naming the pack file and the token', () => {
  it('reports a palette that lost --accent, in the combination it breaks', () => {
    const sources = sourcesOf('studio', 'geist');
    // `--accent` is also in the base, so the copy loses it there too: the palette then has nothing to inherit.
    const without = (css: string): string => css.replace(/^\s*--accent:[^;]*;$/gmu, '');
    const broken = { ...sources, basePalette: without(sources.basePalette), palette: without(sources.palette) };
    const found = problems(broken, 'studio', 'geist', 'light');
    expect(found.some(line => line.includes('styles/palette/geist.css') && line.includes('| accent |'))).toBe(true);
    expect(problems(sources, 'studio', 'geist', 'light')).toEqual([]);
  });

  it('reports a style that lost a prose slot, and a keyword outside its set', () => {
    const sources = sourcesOf('mission', 'studio');
    const broken = {
      ...sources,
      baseStyle: sources.baseStyle.replace(/^\s*--md-quote-bar:[^;]*;$/gmu, ''),
      style:
        sources.style.replace(/^\s*--md-quote-bar:[^;]*;$/gmu, '') +
        "\n:root[data-style='mission'] { --hm-shape: wobbly; }",
    };
    const found = problems(broken, 'mission', 'studio', 'dark');
    expect(found.some(line => line.includes('| md-quote-bar |'))).toBe(true);
    expect(found.some(line => line.includes('| hm-shape | "wobbly"'))).toBe(true);
  });
});
