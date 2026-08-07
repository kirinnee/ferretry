/**
 * Reading Codex's native model picker off a captured pane.
 *
 * Codex has no API for changing the model of a live session: the only route is
 * its own modal picker, driven by keystrokes. That makes the pane text the
 * contract, and it makes classifying the pane the single most safety-critical
 * decision in this file — every key the daemon sends is sent into whatever this
 * function says is on screen. So it is pure, it is table-driven, and it refuses
 * to guess.
 */

/** Which picker Codex currently has open. */
export type CodexPickerKind =
  | 'quick-models'
  | 'all-models'
  | 'reasoning'
  | 'advanced-reasoning'
  | 'plan-scope'
  | 'none';

/** One selectable row: the digit that chooses it and the name it shows. */
export interface CodexPickerRow {
  readonly number: number;
  readonly name: string;
}

export interface CodexPickerScreen {
  readonly kind: CodexPickerKind;
  readonly title?: string;
  readonly rows: readonly CodexPickerRow[];
}

const NOTHING_OPEN: CodexPickerScreen = { kind: 'none', rows: [] };

/** Titles Codex gives each picker, in the order they are matched. */
const PICKER_TITLES: readonly {
  readonly kind: Exclude<CodexPickerKind, 'none'>;
  readonly matches: (line: string) => boolean;
}[] = [
  { kind: 'all-models', matches: line => line === 'Select Model and Effort' },
  { kind: 'reasoning', matches: line => line.startsWith('Select Reasoning Level for ') },
  { kind: 'advanced-reasoning', matches: line => line === 'Advanced Reasoning' },
  { kind: 'plan-scope', matches: line => line === 'Apply reasoning change' },
  { kind: 'quick-models', matches: line => line === 'Select Model' },
];

/** A composer prompt below the title, which proves the numbered rows above it are
 *  scrollback rather than a live screen. A `>` immediately followed by a numbered
 *  item is a quoted list, not a prompt. */
const COMPOSER_PROMPT = /^\s*[│|]?\s*[>›❯»](?!\s*\d+[.)])(?:[\s ].*)?$/u;

/** `1. gpt-5-codex   fast and cheap` — the digit, then the row name. */
const PICKER_ROW = /^\s*(?:[›>]\s*)?(\d+)\.\s+(.+?)\s*$/u;

/**
 * The selectable name in a row.
 *
 * `capture-pane` flattens Codex's two-column rendering onto one line with at
 * least two spaces between the columns, so only the first column is the row
 * name. Trailing `(current)`/`(default)` annotations are stripped repeatedly
 * because Codex can render both at once.
 */
function pickerRowName(value: string): string {
  let cleaned =
    value
      .trim()
      .split(/\s{2,}/u, 1)[0]
      ?.trim() ?? '';
  for (;;) {
    const next = cleaned.replace(/\s+\((?:current|default)\)\s*$/i, '').trim();
    if (next === cleaned) return cleaned;
    cleaned = next;
  }
}

/**
 * Classify a captured pane.
 *
 * The LAST matching title wins, so a picker still sitting in scrollback can
 * never be mistaken for the one that is open — and a numbered list in the
 * conversation can never be mistaken for selectable rows.
 */
export function parseCodexPickerScreen(pane: string): CodexPickerScreen {
  const lines = pane.split('\n');
  let titleIndex = -1;
  let kind: CodexPickerKind = 'none';
  let title: string | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const match = PICKER_TITLES.find(candidate => candidate.matches(line));
    if (match === undefined) continue;
    titleIndex = index;
    kind = match.kind;
    title = line;
  }
  if (titleIndex < 0) return NOTHING_OPEN;

  const below = lines.slice(titleIndex + 1);
  if (below.some(line => COMPOSER_PROMPT.test(line))) return NOTHING_OPEN;

  const rows: CodexPickerRow[] = [];
  for (const line of below) {
    const match = PICKER_ROW.exec(line);
    if (match === null) continue;
    const number = Number(match[1]);
    // A row number that is not a usable digit sequence is not addressable, and
    // guessing which key would select it is exactly the guess this must not make.
    if (!Number.isSafeInteger(number) || number < 1) continue;
    rows.push({ number, name: pickerRowName(match[2] ?? '') });
  }
  return { kind, ...(title === undefined ? {} : { title }), rows };
}

/**
 * True when the pane still shows the exact row a queued keystroke was aimed at.
 *
 * Re-checked immediately before every send: the picker is asynchronous, and a
 * digit typed into a screen that has since changed selects whatever now sits at
 * that position.
 */
export function pickerStillShows(
  pane: string,
  expected: { readonly kind: CodexPickerKind; readonly title?: string; readonly row: CodexPickerRow },
): boolean {
  const current = parseCodexPickerScreen(pane);
  return (
    current.kind === expected.kind &&
    current.title === expected.title &&
    current.rows.some(row => row.number === expected.row.number && row.name === expected.row.name)
  );
}

/** The row that selects a named choice on the current screen. */
export function pickerRowFor(screen: CodexPickerScreen, name: string): CodexPickerRow | undefined {
  return screen.rows.find(row => row.name === name);
}

/**
 * Is a picker OPEN on this pane — as opposed to merely mentioned somewhere in its scrollback?
 *
 * DELIVERY ASKS THIS, and it used to ask a second implementation instead. `tmux/composer.ts` carried
 * its own `/Select Model and Effort|Select Reasoning Level for/` regex, which is a copy of the title
 * table above with two of its five entries — so `/model` opening Codex's QUICK picker, whose title is
 * exactly `Select Model`, matched nothing. Delivery then saw a payload gone from a composer that was
 * not prompt-ready, called it `turn-started`, and the driver refused every targeted Codex switch with
 * "Codex consumed the picker command as a model turn". One fact, two owners, and the copy was wrong.
 *
 * Deriving it from {@link parseCodexPickerScreen} is also STRICTLY SAFER than any regex over the
 * frame, and not by accident: a bare title match fires on a picker that has scrolled up into history,
 * whereas the parser refuses a title with a composer prompt below it — which is exactly the
 * "the modal already closed" frame a second Enter must never be sent into.
 */
export function paneShowsOpenPicker(pane: string): boolean {
  return parseCodexPickerScreen(pane).kind !== 'none';
}
