/**
 * READS THE THEME OFF THE PAGE, as data an illustration library can use — the DOM half of
 * `lib/fy-render-palette.ts`.
 *
 * A token is read from the element the illustration sits in (custom properties inherit, so a swatch
 * preview reads its own family) and RESOLVED to a hex literal, because neither consumer can take what
 * `getPropertyValue` returns: a token may be `rgba(…)`, `color-mix(…)` or an `oklch(…)`, and Chart.js
 * derives its hover shades with a parser that understands none of those, while Mermaid's `base` theme
 * derives every unset slot with one that understands hex and `rgb` only. A canvas does the resolution:
 * paint one pixel in the token and read it back, which is exactly the browser's own colour parser and
 * nothing of ours.
 *
 * Without a canvas (the unit tier's DOM) a token that is already a hex literal passes through and any
 * other resolves to `''`, which every consumer treats as "use your own default".
 */

import { HEX_LITERAL, type ResolvedTheme, THEME_TOKENS, type ThemeToken } from '../lib/fy-render-palette.ts';

let pixel: CanvasRenderingContext2D | null | undefined;

const context = (): CanvasRenderingContext2D | null => {
  if (pixel !== undefined) return pixel;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    pixel = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    pixel = null;
  }
  return pixel;
};

const hex2 = (value: number): string => value.toString(16).padStart(2, '0');

/**
 * Whether the canvas accepted a colour. An unparseable `fillStyle` is ignored rather than refused, so
 * the value is set over two different sentinels: a colour the canvas took reads back the same both
 * times, one it ignored reads back as whichever sentinel was there.
 */
const accepts = (canvas: CanvasRenderingContext2D, value: string): boolean => {
  canvas.fillStyle = '#010203'; // theme-literal-ok: a sentinel the parser test sets, never painted
  canvas.fillStyle = value;
  const first = String(canvas.fillStyle);
  canvas.fillStyle = '#030201'; // theme-literal-ok: the second sentinel, never painted
  canvas.fillStyle = value;
  return String(canvas.fillStyle) === first;
};

/** One CSS colour as `#rrggbb`, or `#rrggbbaa` when it is translucent; `''` when it is not a colour. */
function resolveColor(value: string): string {
  const raw = value.trim();
  if (raw === '') return '';
  const canvas = context();
  if (canvas === null) return HEX_LITERAL.test(raw.toLowerCase()) ? raw.toLowerCase() : '';
  if (!accepts(canvas, raw)) return '';
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = raw;
  canvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
  const rgb = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a === 255 ? rgb : `${rgb}${hex2(a)}`;
}

/** The app's theme name, from the document root. */
export const documentThemeName = (): string =>
  typeof document === 'undefined' ? '' : (document.documentElement.getAttribute('data-theme') ?? '');

/** The page's theme as an illustration sees it, read from `element` (or the document root). */
export function readTheme(element: Element | null): ResolvedTheme {
  const mode = documentThemeName().includes('light') ? 'light' : 'dark';
  const colors = Object.fromEntries(THEME_TOKENS.map(token => [token, ''])) as Record<ThemeToken, string>;
  const unread: ResolvedTheme = { colors, font: '', mode, radius: 0 };
  const target = element ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (target === null || typeof getComputedStyle !== 'function') return unread;
  try {
    const style = getComputedStyle(target);
    for (const token of THEME_TOKENS) colors[token] = resolveColor(style.getPropertyValue(`--${token}`));
    const radius = Number.parseFloat(style.getPropertyValue('--radius-xs'));
    return { colors, font: style.fontFamily, mode, radius: Number.isFinite(radius) ? Math.max(0, radius) : 0 };
  } catch {
    return unread;
  }
}
