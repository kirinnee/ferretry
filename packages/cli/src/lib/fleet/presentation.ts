/**
 * What a terminal lets a fleet rendering do, as values the domain can hold.
 *
 * COLOUR IS DECIDED OUTSIDE AND ARRIVES AS DATA. `src/lib` may not read the environment or import a
 * terminal dependency, and that restriction is the useful one here rather than a formality: whether
 * this invocation may emit escape codes depends on `NO_COLOR` and on whether stdout is a terminal,
 * and a renderer that answered those questions itself would answer them the same way in a test, in a
 * pipe and in a `--json` payload. So the composition root resolves it once and hands in the result.
 *
 * The roles are named for WHAT THEY MEAN, never for the colour that carries them. A renderer that
 * said `red` would be deciding presentation from inside the domain, and the one thing this file
 * exists to keep out is exactly that decision.
 */
export type FleetInk = (text: string) => string;

/**
 * The four things a fleet rendering can say with colour.
 *
 * `muted` covers two cases on purpose — secondary detail, and an honest absence of evidence — because
 * they want the same treatment. An `UNKNOWN` verdict is NOT a warning: it is what Codex correctly
 * publishes about itself, and painting it as a fault would teach a reader to skip real faults.
 */
export interface FleetPalette {
  /** Something is broken and a person can act on it. */
  readonly danger: FleetInk;
  /** Proved fine. */
  readonly good: FleetInk;
  /** Secondary detail, or an honest absence of evidence. Never a warning. */
  readonly muted: FleetInk;
  /** A copy-paste target: an exact command, meant to be selected rather than read. */
  readonly command: FleetInk;
}

const UNPAINTED: FleetInk = text => text;

/** What `NO_COLOR`, a pipe and a redirect all produce. The layout has to stay readable in it. */
export const PLAIN_FLEET_PALETTE: FleetPalette = {
  danger: UNPAINTED,
  good: UNPAINTED,
  muted: UNPAINTED,
  command: UNPAINTED,
};

/** What a terminal that never said how wide it is gets. A pipe has no width, and 80 is the convention. */
export const FALLBACK_TERMINAL_WIDTH = 80;

/** Below this, wrapping degenerates into one word per line and stops being an improvement. */
export const NARROWEST_USABLE_WIDTH = 40;

/** Everything a fleet rendering needs to know about the surface it is being written to. */
export interface FleetPresentation {
  readonly palette: FleetPalette;
  /** Total columns available, including any indent. */
  readonly width: number;
}

/** The presentation a test, a pipe and a `NO_COLOR` terminal share. */
export const PLAIN_FLEET_PRESENTATION: FleetPresentation = {
  palette: PLAIN_FLEET_PALETTE,
  width: FALLBACK_TERMINAL_WIDTH,
};

/**
 * Break a sentence into lines the caller will indent itself.
 *
 * The first line and the rest get DIFFERENT budgets, because the first one usually starts partway
 * across a row — after a glyph, a name and a verdict — while a continuation starts at its own indent.
 * A single budget would either overflow the row or waste most of every continuation.
 *
 * A WORD LONGER THAN ITS BUDGET IS NEVER SPLIT. It overflows on a line of its own instead, because
 * the long tokens in this output are account ids inside a command somebody is about to copy, and a
 * break in the middle of one produces something that looks copyable and is not.
 */
export function softWrap(text: string, firstWidth: number, restWidth: number): readonly string[] {
  const first = Math.max(1, Math.trunc(firstWidth));
  const rest = Math.max(1, Math.trunc(restWidth));
  const words = text.split(' ').filter(word => word !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    const budget = lines.length === 0 ? first : rest;
    if (current.length + 1 + word.length <= budget) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

/** A piece of a line that keeps its own colour, so packing it into rows cannot lose the paint. */
export interface PaintedFragment {
  /** What a reader sees, with no escape codes — the only text a width may be measured against. */
  readonly plain: string;
  /** The same text, painted. Identical to `plain` when colour is off. */
  readonly painted: string;
}

/**
 * Pack coloured fragments onto as few lines as fit, measuring the PLAIN text.
 *
 * Wrapping and colouring fight each other: escape codes have width zero on screen and non-zero in a
 * string, so wrapping painted text puts breaks in the wrong places and can cut a line in the middle
 * of an escape sequence. Fragments carry both forms, so the width is decided on one and emitted from
 * the other, and every fragment stays whole and stays painted.
 */
export function packFragments(
  fragments: readonly PaintedFragment[],
  separator: string,
  firstWidth: number,
  restWidth: number,
): readonly string[] {
  const first = Math.max(1, Math.trunc(firstWidth));
  const rest = Math.max(1, Math.trunc(restWidth));
  const lines: string[] = [];
  let plain = '';
  let painted = '';
  for (const fragment of fragments) {
    if (plain === '') {
      plain = fragment.plain;
      painted = fragment.painted;
      continue;
    }
    const budget = lines.length === 0 ? first : rest;
    if (plain.length + separator.length + fragment.plain.length <= budget) {
      plain = `${plain}${separator}${fragment.plain}`;
      painted = `${painted}${separator}${fragment.painted}`;
      continue;
    }
    lines.push(painted);
    plain = fragment.plain;
    painted = fragment.painted;
  }
  if (plain !== '') lines.push(painted);
  return lines;
}
