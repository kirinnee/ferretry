/**
 * HOW A SEGMENT'S TEXT IS READ. Every agenda segment (premise, context, decided, still open, the answer to a
 * question, the body, an option's detail, a term, a revision's note) is short Markdown the ferret wrote line by
 * line, so the card keeps what the line breaks say. Plain Markdown joins a single newline into the line above it
 * and does not know `•` as a bullet: the result is the wall of text a segment must never be. Pure — nothing here
 * draws anything.
 */

const FENCE = /^\s*(?:```|~~~)/u;
const DOT_BULLET = /^(\s*)•(\s+)/u;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/u;
const BLOCK_START = /^\s*(?:```|~~~|#{1,6}\s|>|\||<)/u;
const TRAILING_BREAK = /(?: {2,}|\\)$/u;

/** Whether a line stays a block of its own — a heading, a table row, a quote or a fence — so no break is added to it. */
const isBlock = (line: string): boolean => BLOCK_START.test(line);

/**
 * The segment as Markdown that keeps its lines: each `•` becomes a `-` bullet, and a line of text followed by another
 * line of text ends in a hard break, so it stays a line. Blank lines, lists, headings, tables, quotes and fenced code
 * are left exactly as written.
 */
export function segmentMarkdown(text: string): string {
  const lines = text.split(/\r?\n/u);
  let fenced = false;
  return lines
    .map((raw, index) => {
      const opens = FENCE.test(raw);
      const inCode = fenced || opens;
      if (opens) fenced = !fenced;
      if (inCode) return raw;
      const line = raw.replace(DOT_BULLET, '$1-$2');
      const next = lines[index + 1];
      if (next === undefined || line.trim() === '' || next.trim() === '') return line;
      if (isBlock(line) || isBlock(next) || LIST_ITEM.test(next) || TRAILING_BREAK.test(line)) return line;
      return `${line}  `;
    })
    .join('\n');
}
