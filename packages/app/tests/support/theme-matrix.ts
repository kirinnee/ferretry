/**
 * THE THEME MATRIX RULES, pure. `tests/integration/theme-matrix.visual.test.ts` measures a specimen page in a real browser and
 * hands what it read to these functions; keeping the rules here means they are unit-tested (`tests/unit/theme-matrix.test.ts`)
 * without a browser, including the two owner decisions that are easy to get wrong:
 *
 *  - a style marked `loud: true` in the catalogue DELIBERATELY fights readability (owner, 2026-11-19: "its ok some style
 *    fights readability rules"), so its contrast misses are WARNINGS; its focus ring, overflow and fonts stay hard failures;
 *  - a miss that exists today and is not this test's to fix is recorded once in a `Known` ledger, and a ledger row that no
 *    longer misses FAILS, so the ledger can only shrink.
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
  readonly text: readonly { readonly what: string; readonly ratio: number }[];
  readonly edge: readonly { readonly what: string; readonly ratio: number }[];
  readonly focus: readonly {
    readonly what: string;
    readonly drawn: boolean;
    readonly width: number;
    readonly ratio: number;
  }[];
  readonly overflow: readonly { readonly what: string; readonly right: number; readonly limit: number }[];
  readonly fonts: readonly { readonly family: string; readonly loaded: boolean }[];
}

/** WCAG 1.4.3 text, 1.4.11 non-text (a control's edge, a focus ring), 2.4.13 ring thickness. */
const TEXT_FLOOR = 4.5;
const EDGE_FLOOR = 3;
const RING_WIDTH_FLOOR = 2;

const ratioText = (ratio: number): string => `${ratio.toFixed(2)}:1`;

/** Every rule, as a pure function of what was measured. */
export function misses(measured: Measured): readonly Miss[] {
  const out: Miss[] = [];
  for (const row of measured.text)
    if (row.ratio < TEXT_FLOOR)
      out.push({ check: 'text', what: row.what, got: ratioText(row.ratio), need: `>=${TEXT_FLOOR}:1` });
  for (const row of measured.edge)
    if (row.ratio < EDGE_FLOOR)
      out.push({ check: 'edge', what: row.what, got: ratioText(row.ratio), need: `>=${EDGE_FLOOR}:1` });
  for (const row of measured.focus) {
    if (!row.drawn || row.width < RING_WIDTH_FLOOR)
      out.push({
        check: 'focus',
        what: `${row.what} ring`,
        got: row.drawn ? `${row.width}px` : 'none drawn',
        need: `>=${RING_WIDTH_FLOOR}px`,
      });
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
    if (!row.loaded) out.push({ check: 'fonts', what: row.family, got: 'not loaded', need: 'loaded' });
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

/** A miss that exists today. Absent `style` / `palette` / `mode` mean "any". */
export interface Known {
  readonly style?: readonly string[];
  readonly palette?: readonly string[];
  readonly mode?: 'light' | 'dark';
  readonly check: Check;
  /** Matched against the miss's `what`. */
  readonly what: RegExp;
  readonly why: string;
}

const matchesKnown = (known: Known, where: Where, miss: Miss): boolean =>
  known.check === miss.check &&
  known.what.test(miss.what) &&
  (known.style === undefined || known.style.includes(where.style)) &&
  (known.palette === undefined || known.palette.includes(where.palette)) &&
  (known.mode === undefined || known.mode === where.mode);

export type Verdict = 'fail' | 'warn' | 'known';

/** What a miss costs: a ledger row first, then the loud-style rule, else a failure. */
export function verdictOf(
  loud: boolean,
  where: Where,
  miss: Miss,
  ledger: readonly Known[],
): { readonly verdict: Verdict; readonly known: number } {
  const known = ledger.findIndex(row => matchesKnown(row, where, miss));
  if (known >= 0) return { verdict: 'known', known };
  return { verdict: loud && SOFTENABLE.has(miss.check) ? 'warn' : 'fail', known: -1 };
}

/** The ledger rows nothing matched: they no longer miss, so they must be deleted. */
export const staleKnown = (ledger: readonly Known[], used: ReadonlySet<number>): readonly Known[] =>
  ledger.filter((_row, index) => !used.has(index));
