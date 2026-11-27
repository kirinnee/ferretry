/**
 * THE THEME'S TOKENS, RESOLVED WITHOUT A BROWSER. For one style × palette × mode this builds the custom-property map the
 * browser would build (base → style → palette, by specificity then source order, as `styles/themes.css` imports them),
 * then follows every `var()` chain to a literal and every colour to an sRGB value. A reader of the result can ask "does this
 * token resolve" and "what is its contrast" in microseconds, which is what lets one unit test hold 384 combinations to the
 * renderer contract (`src/theme/render-contract.ts`).
 *
 * Scope, stated so nobody trusts it for more: only blocks whose whole selector is `:root` plus `data-style` / `data-palette`
 * / `data-mode` attributes count (that is every block that sets a token). At-rules (`@media`) are skipped, so this is the
 * desktop, no-preference baseline (a `@media` override is the browser matrix's to hold, U9, not this static pass).
 * `color-mix` is resolved in sRGB, as `fy-render-theme.ts` resolves it. A colour this file cannot parse is a FAILURE to
 * measure, never a pass: callers report it.
 */
import { luminance, contrastRatio } from './theme-matrix.ts';

export type ThemeMode = 'light' | 'dark';

/** The CSS text of the four layers of one theme, in cascade order. */
export interface ThemeSources {
  readonly baseStyle: string;
  readonly basePalette: string;
  readonly style: string;
  readonly palette: string;
}

export interface ThemeChoice {
  readonly style: string;
  readonly palette: string;
  readonly mode: ThemeMode;
}

interface Block {
  readonly attrs: Readonly<Record<string, string>>;
  readonly declarations: ReadonlyMap<string, string>;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');
const ROOT_SELECTOR = /^:root((?:\[data-(?:style|palette|mode)='[a-z0-9-]+'\])*)$/u;

/** Every token-setting block of a stylesheet, top level only, with the attributes its selector requires. */
function tokenBlocks(css: string): readonly Block[] {
  const text = stripComments(css);
  const out: Block[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) break;
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (text[close] === '{') depth += 1;
      else if (text[close] === '}') depth -= 1;
      close += 1;
    }
    const selector = text.slice(index, open).trim();
    const body = text.slice(open + 1, close - 1);
    index = close;
    if (selector.startsWith('@')) continue;
    const root = selector
      .split(',')
      .map(each => each.trim())
      .map(each => ROOT_SELECTOR.exec(each))
      .find(match => match !== null);
    if (root === undefined || root === null) continue;
    const attrs: Record<string, string> = {};
    for (const match of (root[1] ?? '').matchAll(/\[data-(style|palette|mode)='([a-z0-9-]+)'\]/gu))
      attrs[match[1] as string] = match[2] as string;
    const declarations = new Map<string, string>();
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu))
      declarations.set((match[1] as string).slice(2), (match[2] as string).trim());
    out.push({ attrs, declarations });
  }
  return out;
}

/** The token map the browser builds for one theme: the lowest specificity first, ties by source order, later wins. */
export function tokenMap(sources: ThemeSources, choice: ThemeChoice): ReadonlyMap<string, string> {
  const applies = (block: Block): boolean =>
    Object.entries(block.attrs).every(([axis, id]) => choice[axis as keyof ThemeChoice] === id);
  const matched = [sources.baseStyle, sources.basePalette, sources.style, sources.palette]
    .flatMap(css => tokenBlocks(css))
    .filter(applies)
    .map((block, order) => ({ block, order, specificity: Object.keys(block.attrs).length }))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const map = new Map<string, string>();
  for (const { block } of matched) for (const [name, value] of block.declarations) map.set(name, value);
  return map;
}

/** Why a token does not resolve: a `var()` that names nothing, a cycle, or a chain longer than the contract allows. */
export type Unresolved = { readonly ok: false; readonly reason: string };
export type Resolved = { readonly ok: true; readonly value: string } | Unresolved;

/** The CSS-wide keywords: as a custom property's value they compute to the guaranteed-invalid value, i.e. an empty token. */
const CSS_WIDE = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const isCssWide = (value: string): boolean => CSS_WIDE.has(value.trim().toLowerCase());

/** A reference chain must end in a literal within this many hops. */
export const MAX_HOPS = 8;

class Dangling extends Error {}

/** `value` with every `var()` replaced by what it names (its fallback when it names nothing and has one). */
function substitute(map: ReadonlyMap<string, string>, value: string, trail: readonly string[]): string {
  let out = '';
  let index = 0;
  for (;;) {
    const start = value.indexOf('var(', index);
    if (start === -1) return out + value.slice(index);
    out += value.slice(index, start);
    let depth = 1;
    let end = start + 4;
    while (end < value.length && depth > 0) {
      if (value[end] === '(') depth += 1;
      else if (value[end] === ')') depth -= 1;
      end += 1;
    }
    const inner = value.slice(start + 4, end - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim().slice(2);
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    if (trail.includes(name)) throw new Dangling(`a cycle: ${[...trail, name].map(each => `--${each}`).join(' → ')}`);
    const target = map.get(name);
    if (target !== undefined) {
      if (isCssWide(target))
        throw new Dangling(`--${name} is the CSS-wide keyword "${target.trim()}", which computes to nothing`);
      if (trail.length >= MAX_HOPS) throw new Dangling(`a chain longer than ${MAX_HOPS} hops at --${name}`);
      out += substitute(map, target, [...trail, name]);
    } else if (fallback !== undefined) out += substitute(map, fallback, trail);
    else throw new Dangling(`var(--${name}) names no token`);
    index = end;
  }
}

/** One token as a literal value, or why it is not one. */
export function resolveToken(map: ReadonlyMap<string, string>, name: string): Resolved {
  const own = map.get(name);
  if (own === undefined) return { ok: false, reason: `--${name} is not set` };
  if (isCssWide(own))
    return { ok: false, reason: `--${name} is the CSS-wide keyword "${own.trim()}", which computes to nothing` };
  try {
    const value = substitute(map, own, [name]).trim();
    if (value === '') return { ok: false, reason: `--${name} is empty` };
    if (isCssWide(value))
      return { ok: false, reason: `--${name} resolves to the CSS-wide keyword "${value}", which computes to nothing` };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Dangling) return { ok: false, reason: `--${name}: ${error.message}` };
    throw error;
  }
}

/** A colour as 0-255 channels and an alpha of 0-1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Splits at the top-level commas of a function's argument text. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

const channelValue = (text: string): number =>
  text.endsWith('%') ? (Number.parseFloat(text) / 100) * 255 : Number.parseFloat(text);
const alphaValue = (text: string): number =>
  text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);

/** The named colours the themes may reach for; any other name is unmeasurable and reported as such. */
const NAMED: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

/** A hue as degrees; unitless is degrees, as in CSS. */
function hueValue(text: string): number {
  const number = Number.parseFloat(text);
  if (text.endsWith('grad')) return number * 0.9;
  if (text.endsWith('rad')) return (number * 180) / Math.PI;
  if (text.endsWith('turn')) return number * 360;
  return number;
}

/** sRGB 0-255 channels for a hue (degrees), saturation and lightness (0-1). */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return (lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

/** A literal CSS colour (hex, `rgb()`/`rgba()`, `transparent`, or `hsl()`/`hsla()`, a few named colours, or `color-mix(in srgb, …)` of those), else `undefined`. */
function parseColour(raw: string): Rgba | undefined {
  const text = raw.trim().toLowerCase();
  if (text === 'transparent') return { a: 0, b: 0, g: 0, r: 0 };
  const named = NAMED[text];
  if (named !== undefined) return { a: 1, b: named[2], g: named[1], r: named[0] };
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map(each => each + each).join('') : hex;
    if (full.length !== 6 && full.length !== 8) return undefined;
    const part = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16);
    return { a: full.length === 8 ? part(6) / 255 : 1, b: part(4), g: part(2), r: part(0) };
  }
  const call = /^(rgba?)\((.*)\)$/u.exec(text);
  if (call !== null) {
    const parts = (call[2] as string).split(/[\s,/]+/u).filter(each => each !== '');
    if (parts.length < 3 || parts.length > 4) return undefined;
    const [r, g, b] = parts.slice(0, 3).map(channelValue) as [number, number, number];
    const a = parts[3] === undefined ? 1 : alphaValue(parts[3]);
    return [r, g, b, a].every(Number.isFinite) ? { a: clamp(a, 0, 1), b, g, r } : undefined;
  }
  const hsl = /^hsla?\((.*)\)$/u.exec(text);
  if (hsl !== null) {
    const parts = (hsl[1] as string).split(/[\s,/]+/u).filter(each => each !== '');
    if (parts.length < 3 || parts.length > 4) return undefined;
    const [hue, sat, light] = parts as [string, string, string];
    if (!sat.endsWith('%') || !light.endsWith('%')) return undefined;
    const a = parts[3] === undefined ? 1 : alphaValue(parts[3]);
    const s = Number.parseFloat(sat) / 100;
    const l = Number.parseFloat(light) / 100;
    const h = hueValue(hue);
    if (![h, s, l, a].every(Number.isFinite)) return undefined;
    const [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
    return { a: clamp(a, 0, 1), b, g, r };
  }
  const mix = /^color-mix\((.*)\)$/u.exec(text);
  if (mix !== null) {
    const [space, first, second] = splitTop(mix[1] as string);
    if (space !== 'in srgb' || first === undefined || second === undefined) return undefined;
    const side = (each: string): { colour: Rgba | undefined; percent: number | undefined } => {
      const percent = /\s(\d+(?:\.\d+)?)%$/u.exec(each);
      return {
        colour: parseColour(percent === null ? each : each.slice(0, percent.index)),
        percent: percent === null ? undefined : Number.parseFloat(percent[1] as string),
      };
    };
    const one = side(first);
    const two = side(second);
    if (one.colour === undefined || two.colour === undefined) return undefined;
    const p1 = one.percent ?? (two.percent === undefined ? 50 : 100 - two.percent);
    const p2 = two.percent ?? 100 - p1;
    const total = p1 + p2;
    if (total <= 0) return undefined;
    const w1 = p1 / total;
    const w2 = p2 / total;
    // CSS mixes premultiplied; a total under 100% leaves the rest transparent.
    const alpha = one.colour.a * w1 + two.colour.a * w2;
    const channel = (key: 'r' | 'g' | 'b'): number =>
      alpha === 0 ? 0 : (one.colour![key] * one.colour!.a * w1 + two.colour![key] * two.colour!.a * w2) / alpha;
    return { a: alpha * Math.min(1, total / 100), b: channel('b'), g: channel('g'), r: channel('r') };
  }
  return undefined;
}

/** A token as a colour. */
export function resolveColour(
  map: ReadonlyMap<string, string>,
  name: string,
): { readonly ok: true; readonly colour: Rgba } | Unresolved {
  const resolved = resolveToken(map, name);
  if (!resolved.ok) return resolved;
  const colour = parseColour(resolved.value);
  return colour === undefined
    ? { ok: false, reason: `--${name} is not a colour the resolver reads: ${resolved.value}` }
    : { ok: true, colour };
}

/** `top` painted over an opaque `under`. */
const over = (top: Rgba, under: Rgba): Rgba => ({
  a: 1,
  b: top.b * top.a + under.b * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  r: top.r * top.a + under.r * (1 - top.a),
});

/**
 * The WCAG ratio of `ink` on `ground`. Translucent colours are painted over the page `bg` first (the ground, then the ink
 * over the ground), which is what the eye sees.
 */
export function ratioOf(ink: Rgba, ground: Rgba, page: Rgba): number {
  const base = over(ground, over(page, { a: 1, b: 255, g: 255, r: 255 }));
  const top = over(ink, base);
  return contrastRatio(luminance(top.r, top.g, top.b), luminance(base.r, base.g, base.b));
}
