import type { FormKey } from '@ferretry/core-ferrets/contract';
import type { FerretPane } from '../../daemon/lib/permission/service.ts';

/**
 * A fake ferret pane for the two answer services: it serves a screen, records every key pressed at it, and moves the
 * cursor of a numbered list the way Claude's and Codex's lists move (Up and Down), so the services' own cursor check is
 * what a test exercises. `Enter` and `Escape` end the prompt (the pane shows `after`), unless a test says they do not.
 */
export class KeyPane implements FerretPane {
  readonly keys: FormKey[] = [];
  captures = 0;
  /** Set false to model a prompt that stays up after Enter. */
  clears = true;
  /** Set false to model a cursor that ignores the arrows. */
  moves = true;

  constructor(
    public frame: string,
    private readonly after: string,
  ) {}

  async capture(): Promise<string> {
    this.captures += 1;
    await Promise.resolve();
    return this.frame;
  }

  async key(_ferretId: string, key: FormKey): Promise<void> {
    this.keys.push(key);
    await Promise.resolve();
    if (key === 'Down' || key === 'Up') {
      if (this.moves) this.frame = moveCursor(this.frame, key === 'Down' ? 1 : -1);
      return;
    }
    if (this.clears && (key === 'Enter' || key === 'Escape')) this.frame = this.after;
  }
}

/** A choice row of either harness: gutter, optional cursor marker, a digit, the rest. */
const ROW = /^(\s*)([❯›>]\s)?(\d)([.)]\s.*)$/u;

/** The cursor marker the frame's list uses (`❯ `, `› `), or `undefined` when it has no cursor. */
function markerOf(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    const row = ROW.exec(line);
    if (row?.[2] !== undefined) return row[2];
  }
  return undefined;
}

/** Puts the cursor of the numbered list in `frame` on row `number`, every other row keeping its column. */
export function withCursor(frame: string, number: number): string {
  const marker = markerOf(frame);
  if (marker === undefined) return frame;
  return frame
    .split('\n')
    .map(line => {
      const row = ROW.exec(line);
      if (row === null) return line;
      const [, lead = '', cursor = '', digit = '', rest = ''] = row;
      const width = lead.length + cursor.length;
      const prefix = Number(digit) === number ? ' '.repeat(width - marker.length) + marker : ' '.repeat(width);
      return `${prefix}${digit}${rest}`;
    })
    .join('\n');
}

/** The row number the cursor is on. */
function cursorRow(frame: string): number | undefined {
  for (const line of frame.split('\n')) {
    const row = ROW.exec(line);
    if (row?.[2] !== undefined) return Number(row[3]);
  }
  return undefined;
}

function moveCursor(frame: string, by: number): string {
  const at = cursorRow(frame);
  return at === undefined ? frame : withCursor(frame, at + by);
}
