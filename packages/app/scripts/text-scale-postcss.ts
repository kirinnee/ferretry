/**
 * The "Text size" setting, made true in the stylesheet.
 *
 * The setting used to publish `text-size-adjust: <percent>` on the root and rely on the engine to
 * scale text. Only iPhone-class WebKit text autosizing honours a percentage: iPadOS Safari (desktop-
 * class browsing), the installed standalone app and desktop Safari ignore it — and WebKit builds
 * without it do not even accept the value — so the control did nothing there.
 *
 * Instead every type size is multiplied by `--fy-text-scale`, a unitless factor `applyTextScale` (and
 * `pre-paint.js`) writes on the root. Padding, gaps and touch-target floors are not type, so they stay
 * fixed. This runs AFTER Tailwind so `text-[11px]` utilities and the legacy raw-pixel rules are covered
 * by the one rule, and no source file has to restate the multiplication.
 *
 * Deliberately NOT scaled: `em`/`%` sizes (they inherit an already-scaled parent), compound values such
 * as `max(16px, 1em)` (the iOS focus-zoom floor must not be tuned by a preference), and terminal fit
 * sizes (derived from the pane width, not from taste).
 */

import type { Declaration, Plugin } from 'postcss';

const TEXT_SCALE_VARIABLE = '--fy-text-scale';

/** The design tokens that carry type sizes. Tailwind's `fontSize` scale resolves to exactly these. */
const TYPE_TOKEN =
  /^--(?:text-(?:2xs|xs|sm|base|md|lg|display|input-desktop)|label-size|font-size-base|md-font-size|code-font-size|chrome-font-size)$/u;

const LONE_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem)$/u;

const isTypeSize = (decl: Declaration): boolean =>
  (decl.prop === 'font-size' || TYPE_TOKEN.test(decl.prop)) && LONE_LENGTH.test(decl.value.trim());

export const textScalePostcss = (): Plugin => ({
  postcssPlugin: 'fy-text-scale',
  Declaration(decl) {
    if (!isTypeSize(decl)) return;
    decl.value = `calc(${decl.value.trim()} * var(${TEXT_SCALE_VARIABLE}, 1))`;
  },
});

textScalePostcss.postcss = true as const;
