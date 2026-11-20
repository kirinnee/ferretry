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

/**
 * The checks. The first five are the r10 matrix; the rest are r11 T14's proofs of the owner's theme line (2026-11-20):
 * `gradient` (no gradient backgrounds), `radius` and `clip` (super-rounded and clipped fields), `size` (display and body
 * type), `sidebar` (no accent side bar), `ringclip` (a focus ring inside its clipping ancestor, r11 S13's measure),
 * `distinct` (each style differs from Studio on its components) and `spinner` (no two styles share a spinner).
 */
type Check =
  | 'text'
  | 'edge'
  | 'focus'
  | 'overflow'
  | 'fonts'
  | 'gradient'
  | 'radius'
  | 'clip'
  | 'size'
  | 'sidebar'
  | 'ringclip'
  | 'distinct'
  | 'spinner';

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
    /** The run sits in muted text (`.text-muted`): the High contrast palette asks 4.5:1 of it and 7:1 of the rest. */
    readonly muted?: boolean;
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
    /** The clipping ancestors (described) whose padding box the drawn ring pokes out of; empty or absent = inside. */
    readonly clipped?: readonly string[];
  }[];
  readonly overflow: readonly { readonly what: string; readonly right: number; readonly limit: number }[];
  /** One row per (family, weight, style) a text stack names that is not a device face; `reason` says why it is not loaded. */
  readonly fonts: readonly { readonly what: string; readonly loaded: boolean; readonly reason?: string }[];
  /** r11 T14 facts, read in the page; absent (an older caller) means "not measured". */
  readonly facts?: Facts;
}

/** What the page reports for the style probes: plain data, judged by `misses`. */
export interface Facts {
  /** Every painted background that holds at least one gradient layer (the body's pattern layer is not one: it is the texture). `layers` are the gradient layers. */
  readonly gradients: readonly { readonly what: string; readonly layers: readonly string[] }[];
  /** The computed corner radius, in px, of every multi-line field, code block, table and menu. */
  readonly radii: readonly { readonly what: string; readonly px: number }[];
  /** A two-line textarea whose text does not fit its own box (scroll height over client height). */
  readonly textareaClipped: boolean;
  /** Computed sizes in px: the largest display heading, the body text, and the root font size (1rem). */
  readonly sizes: { readonly display: number; readonly body: number; readonly rem: number };
  /** One row per selected item that draws an accent bar down one side, and how. */
  readonly sideBars: readonly { readonly what: string; readonly how: string }[];
}

/** What a miss is judged against: which style, which palette, and the width (the display cap is a desktop rule). */
export interface Context {
  readonly style: string;
  readonly highContrast: boolean;
  readonly wide: boolean;
}
const DEFAULT_CONTEXT: Context = { style: '', highContrast: false, wide: true };

/**
 * The only backgrounds a style may keep a gradient on (owner: "most of them should not have gradient background"): a Retro
 * panel's title bar and Glass's frost highlight (one element each). A `what` the row names exactly.
 */
const GRADIENT_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  retro: ['Panel header'],
  glass: ['Card'],
};

/** A corner radius for a field, a code block, a table or a menu: no more than this, in every style. */
const RADIUS_CAP_PX = 16;
/** Display text: at most 3.25rem at 1280. Body text: between 0.75rem and 1.15rem (the product's dense 13.5px body is 0.84rem). */
const DISPLAY_CAP_REM = 3.25;
const BODY_MIN_REM = 0.75;
const BODY_MAX_REM = 1.15;
/** High contrast: 7:1 for body text, 4.5:1 for muted text. */
const HC_TEXT_FLOOR = 7;

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
export function misses(measured: Measured, context: Context = DEFAULT_CONTEXT): readonly Miss[] {
  const out: Miss[] = [];
  for (const row of measured.text) {
    // The High contrast palette is stricter than WCAG AA: 7:1 body, 4.5:1 muted, large text included.
    const floor = context.highContrast
      ? row.muted === true
        ? TEXT_FLOOR
        : HC_TEXT_FLOOR
      : isLargeText(row.px, row.weight)
        ? LARGE_TEXT_FLOOR
        : TEXT_FLOOR;
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
  for (const row of measured.focus)
    if (row.reached && row.clipped !== undefined && row.clipped.length > 0)
      out.push({
        check: 'ringclip',
        what: `${row.what} ring`,
        got: `cut by ${row.clipped.join(', ')}`,
        need: 'inside every clipping ancestor',
      });
  out.push(...factMisses(measured.facts, context));
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

/** The r11 T14 rules, as a pure function of the facts the page read. */
function factMisses(facts: Facts | undefined, context: Context): readonly Miss[] {
  if (facts === undefined) return [];
  const out: Miss[] = [];
  const allowed = GRADIENT_ALLOWED[context.style] ?? [];
  for (const row of facts.gradients)
    if (!allowed.includes(row.what))
      out.push({
        check: 'gradient',
        what: `${row.what} background`,
        got: `${row.layers.length} gradient layer(s)`,
        need: 'no gradient',
      });
  for (const row of facts.radii)
    if (row.px > RADIUS_CAP_PX)
      out.push({ check: 'radius', what: row.what, got: `${row.px}px`, need: `<=${RADIUS_CAP_PX}px` });
  if (facts.textareaClipped)
    out.push({ check: 'clip', what: 'two-line textarea text', got: 'clipped', need: 'fits its box' });
  const { display, body, rem } = facts.sizes;
  if (context.wide && display > DISPLAY_CAP_REM * rem)
    out.push({
      check: 'size',
      what: 'display heading',
      got: `${display.toFixed(1)}px`,
      need: `<=${DISPLAY_CAP_REM * rem}px`,
    });
  if (body < BODY_MIN_REM * rem || body > BODY_MAX_REM * rem)
    out.push({
      check: 'size',
      what: 'body text',
      got: `${body.toFixed(1)}px`,
      need: `${BODY_MIN_REM * rem}-${BODY_MAX_REM * rem}px`,
    });
  for (const row of facts.sideBars)
    out.push({ check: 'sidebar', what: row.what, got: row.how, need: 'no accent side bar' });
  return out;
}

/** The eight component probes a style signature is made of. */
export const COMPONENT_PROBES = [
  'button',
  'field',
  'card',
  'mdH1',
  'mdCode',
  'spinner',
  'hypermedia',
  'background',
] as const;
export type ComponentProbe = (typeof COMPONENT_PROBES)[number];
/** One style's colour-free computed-style signature per component probe. */
export type Signature = Readonly<Record<ComponentProbe, string>>;
/** Each style must differ from Studio on at least this many of the 8 component probes. */
const DISTINCT_FLOOR = 6;

/**
 * The cross-style rules (r11 T14 probe 5): `style` differs from Studio on >= 6 of 8 components (Studio itself is the
 * baseline and is exempt), and no two styles share a spinner signature (Studio's included). `signatures` is keyed by style id.
 */
export function contractMisses(style: string, signatures: ReadonlyMap<string, Signature>): readonly Miss[] {
  const own = signatures.get(style);
  const studio = signatures.get('studio');
  if (own === undefined || studio === undefined) return [];
  const out: Miss[] = [];
  if (style !== 'studio') {
    const same = COMPONENT_PROBES.filter(probe => own[probe] === studio[probe]);
    const differs = COMPONENT_PROBES.length - same.length;
    if (differs < DISTINCT_FLOOR)
      out.push({
        check: 'distinct',
        what: `differs from Studio on fewer than ${DISTINCT_FLOOR} of ${COMPONENT_PROBES.length} components`,
        got: `${differs} of ${COMPONENT_PROBES.length} (same as Studio: ${same.join(', ')})`,
        need: `>=${DISTINCT_FLOOR} of ${COMPONENT_PROBES.length}`,
      });
  }
  const twins = [...signatures].filter(([id, sig]) => id !== style && sig.spinner === own.spinner).map(([id]) => id);
  if (twins.length > 0)
    out.push({
      check: 'spinner',
      what: 'spinner shared with another style',
      got: `same as ${twins.join(', ')}`,
      need: 'a spinner of its own',
    });
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
  /** The High contrast palette is hard for every style: a loud style gets no warning exemption on it. */
  highContrast = false,
): { readonly verdict: Verdict; readonly key: string } {
  const key = identity(where, miss);
  if (pins.has(key)) return { verdict: 'known', key };
  return { verdict: loud && !highContrast && SOFTENABLE.has(miss.check) ? 'warn' : 'fail', key };
}

/** The pins whose miss was not observed: they no longer miss, so they must be deleted. */
export const stalePins = (pins: ReadonlyMap<string, string>, observed: ReadonlySet<string>): readonly string[] =>
  [...pins.keys()].filter(key => !observed.has(key)).sort();
