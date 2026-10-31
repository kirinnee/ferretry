/**
 * WHEN A MERMAID DIAGRAM IS COMPILED TOP-TO-BOTTOM — pure functions, no DOM.
 *
 * A diagram is compiled once at Mermaid's natural size (16px text) and shown through the pan/zoom viewport
 * (`fy-render-viewport.ts` decides how it is fitted). What belongs here is the one decision made BEFORE it is
 * compiled: on a narrow column a left-to-right flowchart is declared top-to-bottom — a column is tall and narrow,
 * a left-to-right graph is the opposite, so the flipped one fits the column at a far larger scale.
 */

/** A column narrower than this is a phone's. Wider is a tablet in landscape or a desktop. */
export const MERMAID_NARROW_COLUMN_PX = 520;

const HEADER = /^(\s*(?:graph|flowchart)\s+)(LR|RL)(?=[\s;]|$)/iu;

const FLIPPED: Readonly<Record<string, string>> = { LR: 'TB', RL: 'BT' };

/**
 * The index of the first line of source that is the diagram itself, past what Mermaid allows before it:
 * blank lines, `%%` comments, a `%%{ … }%%` directive (which may span lines) and a leading `---` front
 * matter block. Returns `-1` when nothing but those is there.
 */
function headerLineIndex(lines: readonly string[]): number {
  let at = 0;
  const skip = (): boolean => {
    const line = (lines[at] ?? '').trim();
    if (line === '') return true;
    if (line.startsWith('%%{') && !line.includes('}%%')) {
      while (at + 1 < lines.length && !(lines[at] ?? '').includes('}%%')) at += 1;
      return true;
    }
    return line.startsWith('%%');
  };
  while (at < lines.length && skip()) at += 1;
  if (at < lines.length && (lines[at] ?? '').trim() === '---') {
    let close = at + 1;
    while (close < lines.length && (lines[close] ?? '').trim() !== '---') close += 1;
    if (close >= lines.length) return -1;
    at = close + 1;
    while (at < lines.length && skip()) at += 1;
  }
  return at < lines.length ? at : -1;
}

/**
 * Rewrites a `flowchart`/`graph` declared `LR` or `RL` to `TB` or `BT`. ONLY the direction token on the
 * diagram's own header line is touched: a node label that spells `flowchart LR`, a subgraph's local
 * `direction LR`, and every other kind of diagram are returned byte for byte. Anything that does not
 * match is returned unchanged, so a caller can compare the result to the input to learn whether it did
 * anything.
 */
export function verticalizeMermaid(source: string): string {
  const lines = source.split('\n');
  const at = headerLineIndex(lines);
  if (at < 0) return source;
  const line = lines[at] ?? '';
  const flipped = line.replace(
    HEADER,
    (_whole, lead: string, direction: string) => `${lead}${FLIPPED[direction.toUpperCase()]}`,
  );
  if (flipped === line) return source;
  lines[at] = flipped;
  return lines.join('\n');
}

/** Whether a column is a phone's. A column that could not be measured (0) is treated as wide. */
export function isNarrowColumn(columnPx: number): boolean {
  return columnPx > 0 && columnPx < MERMAID_NARROW_COLUMN_PX;
}
