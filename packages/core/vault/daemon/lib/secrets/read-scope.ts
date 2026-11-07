/**
 * The kernel-bound `Redaction` (§7.3): today's `SecretRedactor.batch` as the one read-scoped redactor every reader
 * shares, owner and ferret alike.
 *
 * ONE OPEN PER READ (S20). `read(fn)` opens the values once, hands `fn` a {@link RedactionScope} over them and
 * revokes it when `fn` settles, so the plaintext lives exactly as long as that one read. Nothing is cached between
 * reads and there is no state on this object.
 *
 * IT FAILS CLOSED (S19). A source that cannot open rejects before `fn` runs, so the read refuses (a stream closes)
 * rather than serving unmasked text. A scope used after its read returned throws rather than masking with values
 * the daemon has let go of.
 *
 * The three shapes a reader needs:
 * - `text`: every known value replaced by `[redacted:NAME]` (S18), longest first.
 * - `cells`: same-width `*` over exactly the matched cells, the grid's shape untouched; the rows are matched as one
 *   run so a value wrapped across rows is masked in each row.
 * - `lines`: the same over plain lines, each line keeping its length.
 *
 * Masking is a UNION over every source: the vault, and whatever else is composed in through `combinedValues` (the
 * input redaction window is added there by the input half; I102). Overlapping matches merge, and each run is
 * replaced once.
 */

import type { CellGrid, Redaction, RedactionScope } from '@ferretry/kernel/contract';
import { coverageOf, type TextRange } from './policy.ts';
import { scrubValues, type RedactionValueSource, type Scrub } from './redaction.ts';

export class VaultRedaction implements Redaction {
  constructor(
    private readonly source: RedactionValueSource,
    private readonly compose: (scrub: Scrub) => Scrub = scrub => scrub,
  ) {}

  async read<T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T> {
    let opened: ReadonlyMap<string, string> | undefined = await this.source.values();
    const values = (): ReadonlyMap<string, string> => {
      if (opened === undefined) throw new Error('a redaction scope was used after the read that opened it ended');
      return opened;
    };
    const needles = (): readonly string[] => [...values().values()].filter(value => value !== '');
    const scrub = this.compose(scrubValues(values));
    try {
      return await fn({
        text: text => {
          values();
          return scrub.text(text);
        },
        cells: grid => maskGrid(grid, needles(), text => scrub.cover(text)),
        lines: lines => maskLines(lines, needles(), text => scrub.cover(text)),
      });
    } finally {
      // Revoked, so a scope that escaped its read holds nothing.
      opened = undefined;
    }
  }
}

/** Every character inside `ranges` replaced by `*`, so the text keeps its length. */
function starred(text: string, ranges: readonly TextRange[], offset: number): string {
  let out = '';
  for (let at = 0; at < text.length; at++) {
    const position = offset + at;
    out += ranges.some(range => position >= range.start && position < range.end) ? '*' : (text[at] ?? '');
  }
  return out;
}

/** Lines matched as one run (a wrapped value spans the join), then cut back into lines of their own lengths. */
export function maskLines(
  lines: readonly string[],
  needles: readonly string[],
  cover: (text: string) => readonly TextRange[] = text => coverageOf(text, needles),
): readonly string[] {
  const ranges = cover(lines.join(''));
  if (ranges.length === 0) return lines;
  const out: string[] = [];
  let offset = 0;
  for (const line of lines) {
    out.push(starred(line, ranges, offset));
    offset += line.length;
  }
  return out;
}

/** Cells matched over the whole grid read row by row; each matched cell becomes `*` of the same width. */
export function maskGrid(
  grid: CellGrid,
  needles: readonly string[],
  cover: (text: string) => readonly TextRange[] = text => coverageOf(text, needles),
): CellGrid {
  const flat: { readonly row: number; readonly cell: number; readonly start: number }[] = [];
  let text = '';
  grid.rows.forEach((row, rowIndex) => {
    row.forEach((cell, cellIndex) => {
      flat.push({ row: rowIndex, cell: cellIndex, start: text.length });
      text += cell;
    });
  });
  const ranges = cover(text);
  if (ranges.length === 0) return grid;
  const rows = grid.rows.map(row => [...row]);
  for (const entry of flat) {
    const cell = rows[entry.row]?.[entry.cell] ?? '';
    const masked = starred(cell, ranges, entry.start);
    if (masked !== cell) (rows[entry.row] as string[])[entry.cell] = masked;
  }
  return { columns: grid.columns, rows };
}
