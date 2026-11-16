/**
 * HOW A SEGMENT'S TEXT IS READ. Every agenda segment (premise, context, decided, still open, the answer to a
 * question, the body, an option's detail, a term, a revision's note) and every text of a board card (ask, summary,
 * brief, How to test, a note) is short Markdown the ferret wrote line by line, so the card keeps what the line breaks
 * say. Plain Markdown joins a single newline into the line above it, does not know `•` as a bullet, and will not let
 * a numbered list that starts at 4 interrupt a paragraph (a label line directly above "4. Run it" swallows the
 * list): the result is the wall of text a segment must never be. Pure — nothing here draws anything.
 */

const FENCE = /^\s*(?:```|~~~)/u;
const DOT_BULLET = /^(\s*)•(\s+)/u;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/u;
const LATE_NUMBER = /^ {0,3}(\d{1,9})[.)]\s/u;
const QUOTE = /^\s*>/u;
const BLOCK_START = /^\s*(?:```|~~~|#{1,6}\s|>|\||<)/u;
const TRAILING_BREAK = /(?: {2,}|\\)$/u;
const INDENTED = /^ {2,}\S/u;

/** Whether a line stays a block of its own — a heading, a table row, a quote or a fence — so no break is added to it. */
const isBlock = (line: string): boolean => BLOCK_START.test(line);

/** What the line above says about the line below: a paragraph or quote it would merge into, a list it belongs to, or neither. */
type Above = 'nothing' | 'text' | 'quote' | 'list' | 'list-gap';

/** Whether a numbered item starting anywhere but 1 sits directly on a paragraph or quote, where Markdown would swallow it. */
const swallowed = (line: string, above: Above): boolean => {
  if (above !== 'text' && above !== 'quote') return false;
  const start = LATE_NUMBER.exec(line)?.[1];
  return start !== undefined && Number(start) !== 1;
};

const aboveAfter = (line: string, above: Above): Above => {
  if (line.trim() === '') return above === 'list' || above === 'list-gap' ? 'list-gap' : 'nothing';
  if (LIST_ITEM.test(line)) return 'list';
  if (above === 'list' || (above === 'list-gap' && INDENTED.test(line))) return 'list';
  if (QUOTE.test(line)) return 'quote';
  return isBlock(line) ? 'nothing' : 'text';
};

/**
 * The segment as Markdown that keeps its lines: each `•` becomes a `-` bullet, and a line of text followed by another
 * line of text ends in a hard break, so it stays a line. A numbered item that starts at 4 (or any number but 1)
 * directly under a label gets the blank line Markdown needs to see a list there. Blank lines, lists, headings, tables,
 * quotes and fenced code are left exactly as written.
 */
export function segmentMarkdown(text: string): string {
  const lines = text.split(/\r?\n/u);
  const out: string[] = [];
  let fenced = false;
  let above: Above = 'nothing';
  lines.forEach((raw, index) => {
    const opens = FENCE.test(raw);
    const inCode = fenced || opens;
    if (opens) fenced = !fenced;
    if (inCode) {
      out.push(raw);
      above = 'nothing';
      return;
    }
    const line = raw.replace(DOT_BULLET, '$1-$2');
    if (swallowed(line, above)) out.push('');
    above = aboveAfter(line, above);
    const next = lines[index + 1];
    const keeps =
      next === undefined ||
      line.trim() === '' ||
      next.trim() === '' ||
      isBlock(line) ||
      isBlock(next) ||
      LIST_ITEM.test(next) ||
      TRAILING_BREAK.test(line);
    out.push(keeps ? line : `${line}  `);
  });
  return out.join('\n');
}
