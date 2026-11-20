/**
 * THE THEME MATRIX RULES, pure. `tests/integration/theme-matrix.visual.test.ts` measures a specimen page in a real browser and
 * hands what it read to these functions; keeping the rules here means they are unit-tested (`tests/unit/theme-matrix.test.ts`)
 * without a browser, including the decisions that are easy to get wrong:
 *
 *  - a style marked `loud: true` in the catalogue DELIBERATELY fights readability (owner, 2026-11-19: "its ok some style
 *    fights readability rules"), so its contrast misses are WARNINGS; its focus ring, overflow and fonts stay hard failures;
 *  - a miss that exists today and is not this test's to fix is PINNED in a `Known` ledger by its exact identity (viewport,
 *    style, palette, mode, check, what) with NO wildcard, and the observed miss set is compared with the pinned set BOTH
 *    ways: a miss nobody pinned fails, and a pin whose miss is gone fails, so the ledger neither grows silently nor goes stale;
 *  - WCAG's 3:1 text floor is for LARGE text only (>= 24px, or >= 18.66px and bold); everything else is 4.5:1.
 */

type Check = 'text' | 'edge' | 'focus' | 'overflow' | 'fonts';

export interface Miss {
  readonly check: Check;
  /** What was measured, for the table. */
  readonly what: string;
  readonly got: string;
  readonly need: string;
}

/** What the page reports for one style x palette x mode; plain data. */
export interface Measured {
  /** `ratio` is the WORST pixel of the painted backdrop; `px` and `weight` decide whether the text is large. */
  readonly text: readonly {
    readonly what: string;
    readonly ratio: number;
    readonly px: number;
    readonly weight: number;
  }[];
  readonly edge: readonly { readonly what: string; readonly ratio: number }[];
  /**
   * One row per control the keyboard must be able to focus. `reached`: Tab or an arrow key really landed on it;
   * `visible`: the browser matched `:focus-visible`; `drawn`: the focused state differs from the resting state by an
   * outline or a border colour (an outline that is there anyway is NOT a focus indicator).
   */
  readonly focus: readonly {
    readonly what: string;
    readonly reached: boolean;
    readonly visible: boolean;
    readonly drawn: boolean;
    readonly width: number;
    readonly ratio: number;
  }[];
  readonly overflow: readonly { readonly what: string; readonly right: number; readonly limit: number }[];
  /** One row per (family, weight, style) a text stack names that is not a device face; `reason` says why it is not loaded. */
  readonly fonts: readonly { readonly what: string; readonly loaded: boolean; readonly reason?: string }[];
}

/** WCAG 1.4.3 text (and its large-text relaxation), 1.4.11 non-text (a control's edge, a focus ring), 2.4.13 ring thickness. */
const TEXT_FLOOR = 4.5;
const LARGE_TEXT_FLOOR = 3;
const EDGE_FLOOR = 3;
const RING_WIDTH_FLOOR = 2;

/** WCAG large text: at least 24px, or at least 18.66px (14pt) and bold (weight 700 or more). */
export const isLargeText = (px: number, weight: number): boolean => px >= 24 || (px >= 18.66 && weight >= 700);

/** WCAG relative luminance of an 8-bit sRGB colour (the 0.04045 knee of the sRGB transfer function). */
export function luminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of two relative luminances. */
export const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const ratioText = (ratio: number): string => `${ratio.toFixed(2)}:1`;

/** Every rule, as a pure function of what was measured. */
export function misses(measured: Measured): readonly Miss[] {
  const out: Miss[] = [];
  for (const row of measured.text) {
    const floor = isLargeText(row.px, row.weight) ? LARGE_TEXT_FLOOR : TEXT_FLOOR;
    if (row.ratio < floor) out.push({ check: 'text', what: row.what, got: ratioText(row.ratio), need: `>=${floor}:1` });
  }
  for (const row of measured.edge)
    if (row.ratio < EDGE_FLOOR)
      out.push({ check: 'edge', what: row.what, got: ratioText(row.ratio), need: `>=${EDGE_FLOOR}:1` });
  for (const row of measured.focus) {
    const need = `>=${RING_WIDTH_FLOOR}px`;
    if (!row.reached) out.push({ check: 'focus', what: `${row.what} ring`, got: 'not reached by keyboard', need });
    else if (!row.visible) out.push({ check: 'focus', what: `${row.what} ring`, got: 'not :focus-visible', need });
    else if (!row.drawn || row.width < RING_WIDTH_FLOOR)
      out.push({ check: 'focus', what: `${row.what} ring`, got: row.drawn ? `${row.width}px` : 'none drawn', need });
    else if (row.ratio < EDGE_FLOOR)
      out.push({
        check: 'focus',
        what: `${row.what} ring colour`,
        got: ratioText(row.ratio),
        need: `>=${EDGE_FLOOR}:1`,
      });
  }
  for (const row of measured.overflow)
    out.push({
      check: 'overflow',
      what: row.what,
      got: `${Math.round(row.right)}px`,
      need: `<=${Math.round(row.limit)}px`,
    });
  for (const row of measured.fonts)
    if (!row.loaded) out.push({ check: 'fonts', what: row.what, got: row.reason ?? 'not loaded', need: 'loaded' });
  return out;
}

/** A loud style may carry only these as warnings. Focus, overflow and fonts are hard for every style. */
const SOFTENABLE: ReadonlySet<Check> = new Set<Check>(['text', 'edge']);

/** Where a miss is: one combination and one viewport. */
export interface Where {
  readonly viewport: string;
  readonly style: string;
  readonly palette: string;
  readonly mode: string;
}

/**
 * A miss that exists today, as the cross product of the lists it names. Every axis is an EXPLICIT list (there is no "any"):
 * a style, palette, mode or width that is not written down is not covered, so a new one that misses fails the day it lands.
 * `what` is the miss's exact text, so a ring-colour failure is not covered by a ring-width entry.
 */
export interface Known {
  readonly viewports: readonly string[];
  readonly styles: readonly string[];
  readonly palettes: readonly string[];
  readonly modes: readonly ('light' | 'dark')[];
  readonly check: Check;
  readonly what: string;
  readonly why: string;
}

/** The one identity of a miss. */
export const identity = (where: Where, miss: Pick<Miss, 'check' | 'what'>): string =>
  [where.viewport, where.style, where.palette, where.mode, miss.check, miss.what].join(' | ');

/** The ledger as `identity -> why`. A row that names the same miss twice is a mistake and throws. */
export function pinnedMisses(ledger: readonly Known[]): ReadonlyMap<string, string> {
  const pins = new Map<string, string>();
  for (const row of ledger)
    for (const viewport of row.viewports)
      for (const style of row.styles)
        for (const palette of row.palettes)
          for (const mode of row.modes) {
            const key = identity({ viewport, style, palette, mode }, row);
            if (pins.has(key)) throw new Error(`the ledger pins ${key} twice`);
            pins.set(key, row.why);
          }
  return pins;
}

export type Verdict = 'fail' | 'warn' | 'known';

/** What a miss costs: a pin first (exact identity), then the loud-style rule, else a failure. */
export function verdictOf(
  loud: boolean,
  where: Where,
  miss: Miss,
  pins: ReadonlyMap<string, string>,
): { readonly verdict: Verdict; readonly key: string } {
  const key = identity(where, miss);
  if (pins.has(key)) return { verdict: 'known', key };
  return { verdict: loud && SOFTENABLE.has(miss.check) ? 'warn' : 'fail', key };
}

/** The pins whose miss was not observed: they no longer miss, so they must be deleted. */
export const stalePins = (pins: ReadonlyMap<string, string>, observed: ReadonlySet<string>): readonly string[] =>
  [...pins.keys()].filter(key => !observed.has(key)).sort();
