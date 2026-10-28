/**
 * THE THEME, AS DATA A RENDERER CAN USE — the one place that decides which app token paints which part of
 * a chart or a Mermaid diagram.
 *
 * An illustration library cannot read CSS custom properties: Chart.js paints a canvas and Mermaid bakes
 * colours into an SVG compiled in another document. So the page reads the tokens once
 * (`components/fy-render-theme.ts`, the only DOM half), resolves each to a hex literal, and hands this
 * module a flat record. Everything here is pure: which tokens are read, how a series `tone` maps onto
 * them, the Mermaid `themeVariables` they become, and the key a compiled diagram is cached under.
 *
 * NO COLOUR IS WRITTEN HERE. Every value comes from `styles/themes.css`; a family that restates a token
 * restates the chart and the diagram with it.
 */

import type { ChartTone } from './fy-render-chart.ts';

/**
 * How many palette slots the theme defines (`--viz-1` … `--viz-8`). It lives here rather than beside the chart
 * reader so the sandbox shell, which imports this module, never pulls a YAML or schema library with it.
 */
export const CHART_PALETTE_SLOTS = 8;

/** Every token an illustration reads, without its leading `--`. */
export const THEME_TOKENS = [
  'viz-1',
  'viz-2',
  'viz-3',
  'viz-4',
  'viz-5',
  'viz-6',
  'viz-7',
  'viz-8',
  'accent',
  'accent-soft',
  'accent-border',
  'ok',
  'ok-bg',
  'warn',
  'warn-bg',
  'err',
  'err-bg',
  'muted',
  'faint',
  'fg',
  'fg-soft',
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-soft',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * The page's theme, resolved: each token as a `#rrggbb` (or `#rrggbbaa`) literal, the body font stack, the
 * smallest corner radius and the reader's mode. An empty string means the token could not be resolved and its consumer falls back.
 */
export interface ResolvedTheme {
  readonly mode: 'light' | 'dark';
  readonly font: string;
  /** The theme's smallest corner (`--radius-xs`) in px: a bar is square in a square family. */
  readonly radius: number;
  readonly colors: Readonly<Record<ThemeToken, string>>;
}

const TONE_TOKEN: Readonly<Record<Exclude<ChartTone, number>, ThemeToken>> = {
  accent: 'accent',
  bad: 'err',
  good: 'ok',
  muted: 'muted',
  warn: 'warn',
};

/** The colour a series asked for: a role's token, or a palette slot (1-based, wrapping). */
export function toneColor(tone: ChartTone, theme: ResolvedTheme): string {
  if (typeof tone === 'number') {
    const slot = (((tone - 1) % CHART_PALETTE_SLOTS) + CHART_PALETTE_SLOTS) % CHART_PALETTE_SLOTS;
    return theme.colors[`viz-${slot + 1}` as ThemeToken];
  }
  return theme.colors[TONE_TOKEN[tone]];
}

/** The palette in slot order, for a pie's slices. */
export const paletteColors = (theme: ResolvedTheme): readonly string[] =>
  Array.from({ length: CHART_PALETTE_SLOTS }, (_, index) => theme.colors[`viz-${index + 1}` as ThemeToken]);

/** A fixed-width hex hash of a string (FNV-1a, 32 bit). A cache key, not a security property. */
const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * WHAT A COMPILED DIAGRAM IS CACHED UNDER: the mode AND the palette. Two dark themes paint the same
 * diagram differently, so "dark" alone would keep a Mission diagram on screen after a switch to Neo.
 * The shape (`<mode>:<8 hex>`) is what the sandbox wire admits.
 */
export const paletteKey = (theme: ResolvedTheme): string =>
  `${theme.mode}:${fnv1a(JSON.stringify([theme.font, theme.radius, THEME_TOKENS.map(token => theme.colors[token])]))}`;

/** The one shape a palette key has, checked where the sandbox echoes it back. */
export const PALETTE_KEY = /^(?:dark|light):[0-9a-f]{8}$/u;

/** A `#rrggbb` or `#rrggbbaa` literal — the only colour shape a diagram's variables may carry. */
export const HEX_LITERAL = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/u;

/**
 * A font stack the sandbox may hand Mermaid: family names, quotes, commas and spaces. It ends up inside
 * the compiled SVG's own `<style>`, so a brace or a semicolon is refused rather than escaped.
 */
export const FONT_STACK = /^[\w\s,'".-]{1,200}$/u;

/** Mermaid's `themeVariables` keys this build sets, and the only ones the sandbox shell admits. */
export const MERMAID_COLOR_VARIABLES = [
  'background',
  'primaryColor',
  'primaryTextColor',
  'primaryBorderColor',
  'secondaryColor',
  'secondaryTextColor',
  'secondaryBorderColor',
  'tertiaryColor',
  'tertiaryTextColor',
  'tertiaryBorderColor',
  'lineColor',
  'textColor',
  'mainBkg',
  'nodeBorder',
  'clusterBkg',
  'clusterBorder',
  'titleColor',
  'edgeLabelBackground',
  'noteBkgColor',
  'noteTextColor',
  'noteBorderColor',
  'actorBkg',
  'actorBorder',
  'actorTextColor',
  'actorLineColor',
  'signalColor',
  'signalTextColor',
  'labelBoxBkgColor',
  'labelBoxBorderColor',
  'labelTextColor',
  'loopTextColor',
  'activationBkgColor',
  'activationBorderColor',
  'sequenceNumberColor',
  'errorBkgColor',
  'errorTextColor',
  'pie1',
  'pie2',
  'pie3',
  'pie4',
  'pie5',
  'pie6',
  'pie7',
  'pie8',
  'pieTitleTextColor',
  'pieSectionTextColor',
  'pieLegendTextColor',
  'pieStrokeColor',
  'pieOuterStrokeColor',
  'git0',
  'git1',
  'git2',
  'git3',
  'git4',
  'git5',
  'git6',
  'git7',
] as const;
type MermaidColorVariable = (typeof MERMAID_COLOR_VARIABLES)[number];

export interface MermaidThemeVariables {
  readonly colors: Readonly<Partial<Record<MermaidColorVariable, string>>>;
  readonly fontFamily: string;
  readonly darkMode: boolean;
}

/**
 * Mermaid's `base` theme, painted from the app's tokens.
 *
 * A node is the accent's soft wash with the accent's own border and the body ink as its text, which is
 * how the app draws a selected card — so a diagram reads as part of the page rather than as a stock
 * Mermaid picture pasted into it. Lines and arrows are muted, notes are the warn wash, a pie and a git
 * graph take the same palette a `chart` does. A token that did not resolve is left out, and Mermaid's
 * `base` theme derives that slot from the ones that did.
 */
export function mermaidThemeVariables(theme: ResolvedTheme): MermaidThemeVariables {
  const c = theme.colors;
  const pick: Record<MermaidColorVariable, string> = {
    activationBkgColor: c['surface-3'],
    activationBorderColor: c.border,
    actorBkg: c['accent-soft'],
    actorBorder: c['accent-border'],
    actorLineColor: c.muted,
    actorTextColor: c.fg,
    background: c.bg,
    clusterBkg: c['surface-2'],
    clusterBorder: c.border,
    edgeLabelBackground: c.surface,
    errorBkgColor: c['err-bg'],
    errorTextColor: c.err,
    git0: c['viz-1'],
    git1: c['viz-2'],
    git2: c['viz-3'],
    git3: c['viz-4'],
    git4: c['viz-5'],
    git5: c['viz-6'],
    git6: c['viz-7'],
    git7: c['viz-8'],
    labelBoxBkgColor: c['surface-2'],
    labelBoxBorderColor: c.border,
    labelTextColor: c.fg,
    lineColor: c.muted,
    loopTextColor: c.fg,
    mainBkg: c['accent-soft'],
    nodeBorder: c['accent-border'],
    noteBkgColor: c['warn-bg'],
    noteBorderColor: c.warn,
    noteTextColor: c.fg,
    pie1: c['viz-1'],
    pie2: c['viz-2'],
    pie3: c['viz-3'],
    pie4: c['viz-4'],
    pie5: c['viz-5'],
    pie6: c['viz-6'],
    pie7: c['viz-7'],
    pie8: c['viz-8'],
    pieLegendTextColor: c.fg,
    pieOuterStrokeColor: c.border,
    pieSectionTextColor: c.bg,
    pieStrokeColor: c.bg,
    pieTitleTextColor: c.fg,
    primaryBorderColor: c['accent-border'],
    primaryColor: c['accent-soft'],
    primaryTextColor: c.fg,
    secondaryBorderColor: c.border,
    secondaryColor: c['surface-2'],
    secondaryTextColor: c.fg,
    sequenceNumberColor: c.bg,
    signalColor: c['fg-soft'],
    signalTextColor: c.fg,
    tertiaryBorderColor: c.border,
    tertiaryColor: c['surface-3'],
    tertiaryTextColor: c.fg,
    textColor: c.fg,
    titleColor: c.fg,
  };
  const colors: Partial<Record<MermaidColorVariable, string>> = {};
  for (const key of MERMAID_COLOR_VARIABLES) if (HEX_LITERAL.test(pick[key])) colors[key] = pick[key];
  return {
    colors,
    darkMode: theme.mode === 'dark',
    fontFamily: FONT_STACK.test(theme.font) ? theme.font : '',
  };
}
