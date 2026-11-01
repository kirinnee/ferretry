/**
 * The navigation, tab, stepper and grouped-card tokens must be legible in EVERY theme.
 *
 * `themes.css` is a cascade, not a table: a theme's value for a token is whatever
 * the baseline says, overridden by its family block, then by its exact mode block,
 * in source order. A pair that passes in Studio can fail in a compact family that
 * only restates part of the ramp, so this suite resolves each of the 22 themes the
 * way the browser does — rule by rule, `var()` chain by `var()` chain — and checks
 * the WCAG ratios each pairing promises.
 *
 * It reads the REAL stylesheet and the REAL catalogue, so a family added to either
 * is checked without editing this file. No DOM: the cascade is resolved here, and
 * that is the point — happy-dom computes no custom properties.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_FAMILIES } from '../../src/lib/theme-preferences.ts';

const css = readFileSync(join(import.meta.dir, '../../src/styles/themes.css'), 'utf8');

const inboxCss = readFileSync(join(import.meta.dir, '../../src/features/agenda/agenda-inbox.css'), 'utf8');

/** The token the Inbox's "How to test" block paints behind its steps (`.fy-totest__how`), read from the real CSS. */
const HOW_GROUND = /\.fy-totest__how\s*\{[^}]*?background:\s*var\(--([\w-]+)\)/.exec(inboxCss)?.[1] ?? null;

const THEMES = THEME_FAMILIES.flatMap(family => [`${family.id}-light`, `${family.id}-dark`]);

/** The tokens the navigation/setup redesign codes against. Names are a contract. */
const TOKENS = [
  'nav-hover',
  'nav-sel-bg',
  'nav-sel-fg',
  'nav-sel-sub',
  'nav-sel-edge',
  'nav-sel-shadow',
  'ground',
  'tab-fg',
  'tab-sel-fg',
  'tab-underline',
  'tab-underline-width',
  'tab-rule',
  'appnav-fg',
  'appnav-sel-fg',
  'appnav-underline',
  'step-done-bg',
  'step-done-fg',
  'step-now-edge',
  'step-now-fg',
  'step-todo-edge',
  'step-todo-fg',
  'step-rail',
  'step-rail-done',
  'step-seg',
  'step-seg-done',
  'step-seg-now',
  'control-transform',
] as const;

/* ---- the cascade ------------------------------------------------------------ */

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
}

/** Top-level rules in source order. At-rules (the mobile floors) are skipped whole. */
const parseRules = (source: string): Rule[] => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open < 0) break;
    const prelude = text.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    for (; close < text.length && depth > 0; close += 1) {
      if (text[close] === '{') depth += 1;
      if (text[close] === '}') depth -= 1;
    }
    cursor = close;
    if (prelude.startsWith('@')) continue;
    const declarations = new Map<string, string>();
    for (const part of text.slice(open + 1, close - 1).split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    rules.push({ selectors: prelude.split(',').map(selector => selector.trim()), declarations });
  }
  return rules;
};

const attributeMatches = (theme: string, operator: string | undefined, value: string): boolean => {
  if (operator === '^') return theme.startsWith(value);
  if (operator === '$') return theme.endsWith(value);
  return theme === value;
};

/** Whether a rule applies to `<html data-theme=theme>` (root) or `<div data-swatch=theme>` (swatch). */
const ruleApplies = (rule: Rule, theme: string, via: 'root' | 'swatch'): boolean =>
  rule.selectors.some(selector => {
    const pattern =
      via === 'root' ? /^:root(?:\[data-theme(\^|\$)?='([^']+)'\])?$/ : /^\[data-swatch(?:(\^|\$)?='([^']+)')?\]$/;
    const match = pattern.exec(selector);
    if (!match) return false;
    return match[2] === undefined || attributeMatches(theme, match[1], match[2]);
  });

const RULES = parseRules(css);

const cascade = (theme: string, via: 'root' | 'swatch'): Map<string, string> => {
  const values = new Map<string, string>();
  for (const rule of RULES) {
    if (!ruleApplies(rule, theme, via)) continue;
    for (const [name, value] of rule.declarations) values.set(name, value);
  }
  return values;
};

const resolve = (values: ReadonlyMap<string, string>, token: string, seen: readonly string[] = []): string => {
  if (seen.includes(token)) throw new Error(`var() cycle: ${[...seen, token].join(' → ')}`);
  const raw = values.get(`--${token}`);
  if (raw === undefined) throw new Error(`--${token} is not declared`);
  return raw.replace(/var\(--([\w-]+)\)/g, (_, inner: string) => resolve(values, inner, [...seen, token]));
};

/* ---- WCAG ------------------------------------------------------------------- */

type Rgba = readonly [number, number, number, number];

const parseColour = (value: string): Rgba | null => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1];
    return [0, 2, 4].map(at => Number.parseInt(digits.slice(at, at + 2), 16)).concat(1) as unknown as Rgba;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  // `color-mix(in srgb, A p%, B)`: the compact families derive roles from their own palette this way, and
  // an sRGB mix is the weighted average of the encoded channels — what the browser paints.
  const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]{3,6})\s+([\d.]+)%,\s*(#[0-9a-f]{3,6})\)$/i.exec(value);
  if (mix?.[1] && mix[2] && mix[3]) {
    const a = parseColour(mix[1]);
    const b = parseColour(mix[3]);
    const weight = Number(mix[2]) / 100;
    if (a && b)
      return [0, 1, 2].map(at => (a[at] ?? 0) * weight + (b[at] ?? 0) * (1 - weight)).concat(1) as unknown as Rgba;
  }
  return null;
};

/** Paint `top` over an opaque `under`. */
const over = (top: Rgba, under: Rgba): Rgba => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1,
];

const luminance = (colour: Rgba): number => {
  const [r, g, b] = colour.slice(0, 3).map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a: Rgba, b: Rgba): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/* ---- the theme under test ---------------------------------------------------- */

interface Resolved {
  readonly theme: string;
  readonly value: (token: string) => string;
  /** A token as an opaque colour, composited over `under` (itself opaque). */
  readonly colour: (token: string, under?: Rgba) => Rgba;
}

const resolvedTheme = (theme: string): Resolved => {
  const values = cascade(theme, 'root');
  const value = (token: string): string => resolve(values, token);
  const colour = (token: string, under?: Rgba): Rgba => {
    const parsed = parseColour(value(token));
    if (!parsed) throw new Error(`${theme}: --${token} resolves to "${value(token)}", not a colour`);
    if (parsed[3] === 1) return parsed;
    // An unspecified ground is the page itself.
    return over(parsed, under ?? colour('bg'));
  };
  return { theme, value, colour };
};

/** The bar the app nav sits on: the translucent `--bar-bg` over the page. */
const appBar = (t: Resolved): Rgba => t.colour('bar-bg', t.colour('bg'));

interface Pair {
  readonly fg: string;
  readonly on: string;
  readonly ground: (t: Resolved) => Rgba;
  readonly kind: 'text' | 'graphic';
}

const onToken =
  (token: string) =>
  (t: Resolved): Rgba =>
    t.colour(token, t.colour('surface'));

const PAIRS: readonly Pair[] = [
  { fg: 'nav-sel-fg', on: '--nav-sel-bg', ground: onToken('nav-sel-bg'), kind: 'text' },
  { fg: 'nav-sel-sub', on: '--nav-sel-bg', ground: onToken('nav-sel-bg'), kind: 'text' },
  { fg: 'tab-fg', on: '--surface', ground: onToken('surface'), kind: 'text' },
  { fg: 'tab-fg', on: '--bg', ground: onToken('bg'), kind: 'text' },
  { fg: 'tab-sel-fg', on: '--surface', ground: onToken('surface'), kind: 'text' },
  { fg: 'tab-sel-fg', on: '--bg', ground: onToken('bg'), kind: 'text' },
  { fg: 'appnav-fg', on: '--bar-bg', ground: appBar, kind: 'text' },
  { fg: 'appnav-fg', on: '--bg', ground: onToken('bg'), kind: 'text' },
  { fg: 'appnav-sel-fg', on: '--bar-bg', ground: appBar, kind: 'text' },
  { fg: 'appnav-sel-fg', on: '--bg', ground: onToken('bg'), kind: 'text' },
  { fg: 'step-done-fg', on: '--step-done-bg', ground: onToken('step-done-bg'), kind: 'text' },
  { fg: 'step-now-fg', on: '--surface', ground: onToken('surface'), kind: 'text' },
  { fg: 'step-todo-fg', on: '--surface', ground: onToken('surface'), kind: 'text' },
  { fg: 'tab-underline', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'tab-underline', on: '--bg', ground: onToken('bg'), kind: 'graphic' },
  { fg: 'appnav-underline', on: '--bar-bg', ground: appBar, kind: 'graphic' },
  { fg: 'step-done-bg', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'step-now-edge', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'step-todo-edge', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'step-rail-done', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'step-seg-done', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
  { fg: 'step-seg-now', on: '--surface', ground: onToken('surface'), kind: 'graphic' },
];

/** High Contrast promises 7:1 for every text colour (its header), so its nav keeps that promise. */
const textMinimum = (theme: string): number => (theme.startsWith('contrast-') ? 7 : 4.5);

/**
 * contrast-dark is the one theme whose card surface IS pure black, so no ground can
 * sit darker behind it. Its grouped cards are separated by the family's 2px white
 * edges instead, which is the mechanism that family uses everywhere else.
 */
const GROUND_EXEMPT = new Set(['contrast-dark']);

const failuresFor = (theme: string): string[] => {
  const t = resolvedTheme(theme);
  const failures: string[] = [];
  const check = (passed: boolean, message: string): void => {
    if (!passed) failures.push(`${theme}: ${message}`);
  };

  for (const pair of PAIRS) {
    const ground = pair.ground(t);
    const measured = ratio(t.colour(pair.fg, ground), ground);
    const minimum = pair.kind === 'text' ? textMinimum(theme) : 3;
    check(measured >= minimum, `--${pair.fg} on ${pair.on} is ${measured.toFixed(2)}:1, needs ${minimum}:1`);
  }

  // The Inbox's How to test block: its title, step text and step numbers must read on whatever it is painted with.
  if (HOW_GROUND === null) failures.push(`${theme}: .fy-totest__how paints no background token`);
  else {
    const how = t.colour(HOW_GROUND, t.colour('surface'));
    for (const fg of ['fg', 'muted', 'accent-strong']) {
      const measured = ratio(t.colour(fg, how), how);
      check(
        measured >= textMinimum(theme),
        `How to test: --${fg} on --${HOW_GROUND} is ${measured.toFixed(2)}:1, needs ${textMinimum(theme)}:1`,
      );
    }
  }

  const surface = t.colour('surface');
  const selBg = t.colour('nav-sel-bg', surface);
  const edge = t.colour('nav-sel-edge', surface);
  check(
    Math.max(ratio(edge, surface), ratio(edge, selBg)) >= 1.2,
    `--nav-sel-edge is invisible against both --surface and --nav-sel-bg`,
  );
  check(
    Math.max(ratio(selBg, surface), ratio(edge, surface)) >= 1.2,
    `the selected pill (--nav-sel-bg / --nav-sel-edge) does not stand off --surface`,
  );
  check(ratio(t.colour('nav-hover', surface), surface) >= 1.04, `--nav-hover is indistinguishable from --surface`);

  const doneSeg = t.colour('step-seg-done', surface);
  const nowSeg = t.colour('step-seg-now', surface);
  check(ratio(doneSeg, nowSeg) >= 1.3, `--step-seg-now is not visibly different from --step-seg-done`);

  if (!GROUND_EXEMPT.has(theme)) {
    const ground = t.colour('ground', surface);
    check(ratio(ground, surface) >= 1.08, `--ground is only ${ratio(ground, surface).toFixed(2)}:1 off --surface`);
    if (theme.endsWith('-dark')) check(luminance(ground) < luminance(surface), `--ground is not darker than --surface`);
  }

  const width = /^(\d+(?:\.\d+)?)px$/.exec(t.value('tab-underline-width'));
  check(width !== null && Number(width[1]) >= 2, `--tab-underline-width must be at least 2px`);
  check(t.value('control-transform') === 'none', `--control-transform must be none (no all-caps navigation)`);
  check(t.value('nav-sel-shadow').length > 0, `--nav-sel-shadow is empty`);
  return failures;
};

describe('navigation theme tokens', () => {
  it('resolves every theme in the catalogue', () => {
    expect(THEMES).toHaveLength(22);
  });

  for (const theme of THEMES) {
    it(`${theme}: every pairing meets its contrast promise`, () => {
      expect(failuresFor(theme)).toEqual([]);
    });

    it(`${theme}: the swatch preview resolves the same values as the page`, () => {
      // Arrange
      const page = cascade(theme, 'root');
      const swatch = cascade(theme, 'swatch');

      // Act
      const differing = TOKENS.filter(token => resolve(page, token) !== resolve(swatch, token));

      // Assert
      expect(differing).toEqual([]);
    });
  }
});
