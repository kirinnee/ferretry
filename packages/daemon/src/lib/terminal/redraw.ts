/**
 * What one pane capture becomes on the wire: a full redraw, or only what changed since the last one.
 *
 * tmux offers a capture, not a delta feed, so every poll yields the whole pane — up to two thousand
 * lines of history above the visible screen. Sending that whole picture for every keystroke cost a
 * terminal a hundred kilobytes and a full repaint per echoed character, and once the history passed a
 * §14 record's budget (`docs/relay-protocol.md`, "Data") the redraw was dropped every time and the
 * viewer never saw the pane again. This module decides the smallest frame that turns the viewer's
 * screen into the new capture. Pure: no IO, no clock, no socket.
 *
 * THE INVARIANT EVERY DELTA RESTS ON: after a frame the transport ACCEPTED, the viewer's visible screen
 * is exactly that capture's visible rows. A full redraw establishes it; a delta preserves it, because a
 * delta either repaints the visible rows that differ (nothing scrolled) or repaints every visible row
 * after pushing the newly scrolled lines through the bottom of the screen (something did). So a delta
 * is only ever computed against the capture of the last ACCEPTED frame, and only for a viewer whose
 * emulator is the pane's own size — a viewer of another size wraps rows differently, and only a full
 * redraw, which repaints everything, is safe for it.
 *
 * What a delta cannot guarantee is the viewer's SCROLLBACK, and it does not pretend to: when a frame's
 * newly scrolled lines exceed the byte budget, the oldest of them are left out, and the viewer's
 * history has a gap there. The visible screen is never wrong because of it.
 */

import { utf8ByteLength } from './stream-policy.ts';

/** One pane capture, as this policy reads it. */
export interface TerminalCapture {
  /** Every captured row, history first and the visible screen last, each carrying its own colour codes. */
  readonly lines: readonly string[];
  /** The pane's visible size: the last `rows` of {@link lines} are the screen. */
  readonly cols: number;
  readonly rows: number;
  /** The cursor, zero-based, within the visible screen. */
  readonly cursorX: number;
  readonly cursorY: number;
  /**
   * How many lines of history the PANE holds — tmux's own count, which can be more than {@link lines}
   * carries, because a capture reads only a window of it. A history that was cleared shows here even
   * when the screen did not change.
   */
  readonly historySize: number;
}

/** The size of the emulator a viewer is drawing into, as the viewer last reported it. */
export interface TerminalViewerSize {
  readonly cols: number;
  readonly rows: number;
}

const ESC = '\u001b';
/** Erase the viewer's scrollback and screen and home the cursor: the start of every full redraw. */
const FULL_PREFIX = `${ESC}[3J${ESC}[2J${ESC}[H`;
/**
 * Reset colours, then erase the whole row in the default colour, before a row is repainted. tmux ends
 * every captured row with its own reset, so a row repainted alone needs nothing from the rows above it.
 */
const ROW_PREFIX = `${ESC}[0m${ESC}[2K`;
/** How many candidate alignments of the history are compared before the search gives up. */
const MAX_HISTORY_ALIGNMENTS = 8;

function cursorTo(capture: TerminalCapture): string {
  const x = Number.isFinite(capture.cursorX) ? Math.max(0, Math.trunc(capture.cursorX)) : 0;
  const y = Number.isFinite(capture.cursorY) ? Math.max(0, Math.trunc(capture.cursorY)) : 0;
  return `${ESC}[${String(y + 1)};${String(x + 1)}H`;
}

function screenOf(capture: TerminalCapture): readonly string[] {
  return capture.lines.slice(Math.max(0, capture.lines.length - capture.rows));
}

function historyOf(capture: TerminalCapture): readonly string[] {
  return capture.lines.slice(0, Math.max(0, capture.lines.length - capture.rows));
}

/**
 * The newest `lines` whose rows fit in `budget` bytes once each is joined by `separator`, in order.
 * Lines are taken from the END, because the newest history is the part a reader scrolls back to first.
 */
function newestFitting(lines: readonly string[], budget: number, separator: number): readonly string[] {
  let used = 0;
  let from = lines.length;
  while (from > 0) {
    const cost = utf8ByteLength(lines[from - 1] ?? '') + separator;
    if (used + cost > budget) break;
    used += cost;
    from -= 1;
  }
  return lines.slice(from);
}

/**
 * A complete redraw: erase everything, then write the history and the screen top to bottom, so the
 * history scrolls up into the viewer's scrollback and the screen is left showing the visible rows.
 *
 * History is TRIMMED FROM THE OLDEST to fit `budgetBytes`. A redraw over the budget is one no record
 * can carry, and a carrier drops it — which, before this cap, meant any terminal with a few hundred
 * lines of history was never painted again. When even the screen alone is over the budget the frame is
 * returned whole and the carrier's own oversize rule decides; there is no smaller honest picture.
 */
export function terminalFullRedraw(capture: TerminalCapture, budgetBytes: number): string {
  const screen = screenOf(capture);
  const cursor = cursorTo(capture);
  const screenBytes = utf8ByteLength(FULL_PREFIX) + utf8ByteLength(screen.join('\r\n')) + utf8ByteLength(cursor);
  const history = newestFitting(historyOf(capture), budgetBytes - screenBytes, 2);
  return `${FULL_PREFIX}${[...history, ...screen].join('\r\n')}${cursor}`;
}

/**
 * Whether two captures show the same picture. Captures may hold different depths of history (a poll
 * reads a window, a complete redraw all of it), so what is compared is everything the shallower one
 * holds: its size, its cursor, its screen and its history, against the same newest lines of the other.
 */
function sameScreen(left: TerminalCapture, right: TerminalCapture): boolean {
  if (
    left.cols !== right.cols ||
    left.rows !== right.rows ||
    left.cursorX !== right.cursorX ||
    left.cursorY !== right.cursorY ||
    left.historySize !== right.historySize
  )
    return false;
  const shared = Math.min(left.lines.length, right.lines.length);
  for (let from = 1; from <= shared; from += 1)
    if (left.lines[left.lines.length - from] !== right.lines[right.lines.length - from]) return false;
  return true;
}

/**
 * How many lines `next`'s history gained at its end over `previous`'s — or `undefined` when the two are
 * not one history that grew (it was cleared, rewritten, or reflowed), which only a full redraw repairs.
 *
 * `next` is `previous` with `n` lines appended and, at tmux's capture limit, as many dropped from the
 * front: so `next` minus its last `n` lines must be a suffix of `previous`. The smallest such `n` is the
 * answer. A previous history that was EMPTY accepts any `next` — that is the return from an alternate
 * screen, whose full redraw already left the viewer with no scrollback to contradict.
 */
function historyGrowth(previous: readonly string[], next: readonly string[]): number | undefined {
  if (previous.length === 0) return next.length;
  let compared = 0;
  for (let overlap = Math.min(previous.length, next.length); overlap >= 1; overlap -= 1) {
    // The newest line `next` shares with `previous` must be `previous`'s newest line: a cheap test that
    // rules out almost every alignment before a whole comparison is paid for.
    if (next[overlap - 1] !== previous[previous.length - 1]) continue;
    compared += 1;
    if (compared > MAX_HISTORY_ALIGNMENTS) return undefined;
    const offset = previous.length - overlap;
    let same = true;
    for (let index = 0; index < overlap - 1 && same; index += 1) same = next[index] === previous[offset + index];
    if (same) return next.length - overlap;
  }
  return undefined;
}

/**
 * What to send a viewer: nothing, a delta, or a complete redraw.
 *
 * `full` carries no frame on purpose. A delta needs only the few hundred newest history lines a poll
 * captures, while a complete redraw is worth the whole history the capture limit allows — so the
 * caller, which owns the IO, captures again for it and builds it with {@link terminalFullRedraw}.
 */
export type TerminalRedrawPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'delta'; readonly frame: string }
  | { readonly kind: 'full' };

const UNCHANGED: TerminalRedrawPlan = { kind: 'unchanged' };
const FULL: TerminalRedrawPlan = { kind: 'full' };

/**
 * How to turn the viewer's screen from `previous` into `next`.
 *
 * `previous` is the capture of the last frame the transport accepted for THIS viewer, or `undefined`
 * when there is none (a fresh attach, a dropped frame, a resize). `viewer` is the size the viewer last
 * reported for its own emulator, or `undefined` when it has reported none. The two captures may hold
 * different amounts of history — a poll reads a window, a complete redraw reads it all — because the
 * history is only ever compared by its newest lines.
 */
export function planTerminalRedraw(
  previous: TerminalCapture | undefined,
  next: TerminalCapture,
  viewer: TerminalViewerSize | undefined,
  budgetBytes: number,
): TerminalRedrawPlan {
  // An unchanged pane sends nothing, whoever is watching: an idle terminal is polled ten times a second.
  if (previous !== undefined && sameScreen(previous, next)) return UNCHANGED;
  const deltaSafe =
    previous !== undefined &&
    viewer !== undefined &&
    viewer.cols === next.cols &&
    viewer.rows === next.rows &&
    previous.cols === next.cols &&
    previous.rows === next.rows;
  if (!deltaSafe) return FULL;
  const grown = historyGrowth(historyOf(previous), historyOf(next));
  if (grown === undefined) return FULL;
  const screen = screenOf(next);
  const cursor = cursorTo(next);
  if (grown === 0) {
    // Nothing scrolled: the viewer's screen IS `previous`'s, so only the rows that differ are repainted.
    const before = screenOf(previous);
    let rows = '';
    for (let row = 0; row < screen.length; row += 1) {
      if (screen[row] !== before[row]) rows += `${ESC}[${String(row + 1)};1H${ROW_PREFIX}${screen[row] ?? ''}`;
    }
    return { kind: 'delta', frame: `${rows}${cursor}` };
  }
  // Something scrolled: from the top-left, write the newly scrolled lines and then the whole screen.
  // The first `rows` lines overwrite the old screen; every line after them scrolls one line into the
  // viewer's scrollback — exactly the lines tmux added to its history. Row-by-row, because the
  // erase-before-write is what makes overwriting an old, longer row safe.
  const screenCost = utf8ByteLength(screen.join('\r\n')) + screen.length * utf8ByteLength(ROW_PREFIX);
  const scrolled = newestFitting(
    historyOf(next).slice(-grown),
    budgetBytes - screenCost - utf8ByteLength(`${ESC}[H${cursor}`),
    utf8ByteLength(ROW_PREFIX) + 2,
  );
  return {
    kind: 'delta',
    frame: `${ESC}[H${[...scrolled, ...screen].map(line => `${ROW_PREFIX}${line}`).join('\r\n')}${cursor}`,
  };
}

/**
 * Read one combined capture: the pane's rows, then the geometry line `display-message` printed after
 * them — `cursor_x|cursor_y|pane_width|pane_height|history_size`. A geometry line that does not parse leaves the
 * cursor at the origin and the size at what the rows themselves show, rather than refusing a picture
 * that is otherwise fine.
 */
export function parseTerminalCapture(stdout: string): TerminalCapture {
  const lines = stdout.replace(/\n$/u, '').split('\n');
  const geometry = (lines.pop() ?? '').trim().split('|');
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
  };
  const rows = Math.min(lines.length, number(geometry[3], lines.length));
  return {
    lines,
    cursorX: number(geometry[0], 0),
    cursorY: number(geometry[1], 0),
    cols: number(geometry[2], 0),
    rows,
    historySize: number(geometry[4], lines.length - rows),
  };
}
