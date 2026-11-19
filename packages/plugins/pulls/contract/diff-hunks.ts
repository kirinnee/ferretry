/**
 * The unified-diff hunk parser (r9 E5). PURE: text in, lines out, no I/O and no clock. E6 (review threads) and E7 (quote
 * and comment) import it; only E5 edits it.
 *
 * Input is what GitHub sends as a file's `patch`: the hunks only, with no `diff --git` or `---`/`+++` header. Each hunk
 * opens with `@@ -oldStart[,oldCount] +newStart[,newCount] @@ [section]`, then lines starting with ` ` (context), `+`
 * (added), `-` (removed) or `\` (the "No newline at end of file" marker, which belongs to the line above it).
 *
 * The one promise: every line carries the line number it has on each side it exists on, so a thread or a quote that GitHub
 * placed by `(path, side, line)` lands on exactly one row: `findLine`.
 */

type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The text after the one-character marker. */
  readonly text: string;
  /** The line number in the old file; absent for an added line. */
  readonly oldLine?: number;
  /** The line number in the new file; absent for a removed line. */
  readonly newLine?: number;
  /** GitHub's "\ No newline at end of file" followed this line. */
  readonly noNewline?: boolean;
  /** Characters of this line past `MAX_LINE_CHARS` that `text` leaves out. */
  readonly cut?: number;
}

export interface DiffHunk {
  /** The header as written (`@@ -1,3 +1,4 @@ section`). */
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** The text after the closing `@@`, if any. */
  readonly section?: string;
  readonly lines: readonly DiffLine[];
}

export interface ParsedPatch {
  readonly hunks: readonly DiffHunk[];
  /** Text before the first hunk or a line that is not a diff line: kept out of the hunks, never dropped silently. */
  readonly stray: number;
  /** Rows after a bound (`MAX_HUNKS`, `MAX_PATCH_LINES`) that were counted but not parsed. */
  readonly omitted: number;
}

/** The most hunks one file's patch builds; the rest is counted in `omitted`, never parsed. */
export const MAX_HUNKS = 1_000;
/** The most diff lines (not hunk headers) one file's patch builds across all its hunks. */
export const MAX_PATCH_LINES = 20_000;
/** The longest text one line or hunk header keeps; the rest is counted on the line (`cut`), so a row's height is bounded. */
export const MAX_LINE_CHARS = 500;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?([^\n]*))?$/u;

/** `text` cut to `MAX_LINE_CHARS` without splitting a surrogate pair: what is kept, and how many characters were left out. */
function bounded(text: string, from: number, to: number): { readonly text: string; readonly cut: number } {
  let stop = Math.min(to, from + MAX_LINE_CHARS);
  // A pair cut in the middle would leave a lone surrogate, which no font draws.
  const last = text.charCodeAt(stop - 1);
  if (stop < to && stop > from && last >= 0xd800 && last <= 0xdbff) stop -= 1;
  return { text: text.slice(from, stop), cut: to - stop };
}

/**
 * Parses a patch. Total: a text with no hunk answers no hunks, a malformed line is counted in `stray`, it never throws.
 * Bounded: past `MAX_HUNKS` hunks or `MAX_PATCH_LINES` lines the rest is only counted (`omitted`), and a line longer than
 * `MAX_LINE_CHARS` keeps its start and says how much it left out (`cut`), so a hostile or huge patch costs a fixed amount.
 */
export function parsePatch(patch: string): ParsedPatch {
  const hunks: DiffHunk[] = [];
  let stray = 0;
  let built = 0;
  let omitted = 0;
  let over = false;
  let current: { header: RegExpExecArray; line: string; lines: DiffLine[]; oldNo: number; newNo: number } | undefined;

  const close = (): void => {
    if (current === undefined) return;
    const [, oldStart, oldCount, newStart, newCount, section] = current.header;
    hunks.push({
      header: current.line,
      oldStart: Number(oldStart),
      oldCount: oldCount === undefined ? 1 : Number(oldCount),
      newStart: Number(newStart),
      newCount: newCount === undefined ? 1 : Number(newCount),
      ...(section === undefined || section === '' ? {} : { section }),
      lines: current.lines,
    });
    current = undefined;
  };

  // Scanned in place (no split of the whole text): a trailing newline ends the last line, it does not start an empty one.
  let at = 0;
  while (at < patch.length) {
    let stop = patch.indexOf('\n', at);
    if (stop === -1) stop = patch.length;
    const from = at;
    at = stop + 1;
    const isHeader = patch.startsWith('@@', from);
    if (isHeader && hunks.length + (current === undefined ? 0 : 1) >= MAX_HUNKS) over = true;
    if (over || built >= MAX_PATCH_LINES) {
      // Over a bound: this row and every row after it are only counted (the lines of a refused hunk are not its neighbour's).
      over = true;
      omitted += 1;
      continue;
    }
    const head = isHeader ? bounded(patch, from, stop).text : '';
    const header = isHeader ? HUNK_HEADER.exec(head) : null;
    if (header !== null) {
      close();
      current = {
        header,
        line: head,
        lines: [],
        oldNo: Number(header[1]),
        newNo: Number(header[3]),
      };
      continue;
    }
    if (current === undefined) {
      stray += 1;
      continue;
    }
    const marker = patch[from];
    const kept = bounded(patch, from + 1, stop);
    const extra = kept.cut === 0 ? {} : { cut: kept.cut };
    if (marker === '\\') {
      const last = current.lines.pop();
      if (last === undefined) stray += 1;
      else current.lines.push({ ...last, noNewline: true });
    } else if (marker === '+') {
      current.lines.push({ kind: 'add', text: kept.text, newLine: current.newNo, ...extra });
      current.newNo += 1;
      built += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', text: kept.text, oldLine: current.oldNo, ...extra });
      current.oldNo += 1;
      built += 1;
    } else if (marker === ' ' || stop === from) {
      // An empty row inside a hunk is an empty context line whose leading space an editor or a trim removed.
      current.lines.push({
        kind: 'context',
        text: kept.text,
        oldLine: current.oldNo,
        newLine: current.newNo,
        ...extra,
      });
      current.oldNo += 1;
      current.newNo += 1;
      built += 1;
    } else {
      stray += 1;
    }
  }
  close();
  return { hunks, stray, omitted };
}

/** GitHub's side words for a line's place: `left` is the old file, `right` the new one. */
export type DiffSide = 'left' | 'right';

/** The line that sits at `line` on `side`, with the hunk it is in; `undefined` when no hunk shows that line. */
export function findLine(
  patch: ParsedPatch,
  side: DiffSide,
  line: number,
): { readonly hunk: number; readonly index: number; readonly line: DiffLine } | undefined {
  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    for (const [index, candidate] of hunk.lines.entries()) {
      const number = side === 'left' ? candidate.oldLine : candidate.newLine;
      if (number === line) return { hunk: hunkIndex, index, line: candidate };
    }
  }
  return undefined;
}

/** One row of the side-by-side view: a removed line against the added line that replaced it, or a lone line. */
export interface SplitRow {
  readonly left?: DiffLine;
  readonly right?: DiffLine;
}

/**
 * The split view of one hunk. Context lines sit on both sides. A run of removed lines followed by a run of added lines
 * is paired by position (the first removed with the first added …); the longer run's remainder sits alone.
 */
export function splitRows(hunk: DiffHunk): readonly SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = (): void => {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index += 1) {
      const left = removed[index];
      const right = added[index];
      rows.push({ ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) });
    }
    removed = [];
    added = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') {
      // A removed line after an added one starts a new change run.
      if (added.length > 0) flush();
      removed.push(line);
    } else if (line.kind === 'add') added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/** The plain text of a selection of lines, one per row, as a quote wants it (`path:line` is E7's to add). */
export const lineText = (lines: readonly DiffLine[]): string => lines.map(line => line.text).join('\n');

/**
 * The first `budget` lines of the hunks, in order, with how many lines that leaves out. A hunk is cut mid-way when the
 * budget ends inside it. Pure: this is how the view reveals a long diff a page at a time without parsing it again.
 */
export function takeLines(
  hunks: readonly DiffHunk[],
  budget: number,
): { readonly hunks: readonly DiffHunk[]; readonly hidden: number } {
  const shown: DiffHunk[] = [];
  let room = budget;
  let hidden = 0;
  for (const hunk of hunks) {
    if (room <= 0) hidden += hunk.lines.length;
    else if (hunk.lines.length <= room) {
      shown.push(hunk);
      room -= hunk.lines.length;
    } else {
      shown.push({ ...hunk, lines: hunk.lines.slice(0, room) });
      hidden += hunk.lines.length - room;
      room = 0;
    }
  }
  return { hunks: shown, hidden };
}
