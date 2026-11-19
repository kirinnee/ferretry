/**
 * Quoting, as pure text. What a person selects is a stranger's words (a description, a comment, a diff line): it goes into a
 * text box as plain text and nowhere as markup, so it is cleaned first and bounded, never trusted.
 */

/** The most characters one quote carries; a longer selection is cut and says so. */
export const MAX_QUOTE_CHARS = 4_000;
/** Selection text read from the page is cut here before it is cleaned (a select-all of a huge page is not read whole). */
const MAX_READ_CHARS = 20_000;

/** A diff selection's place: the file and the lines it covers, on one side. */
export interface DiffRange {
  readonly path: string;
  readonly side: 'left' | 'right';
  readonly startLine: number;
  readonly line: number;
}

/**
 * Text with the invisible controls taken out: bidirectional overrides and isolates, zero-width joiners and the other
 * format characters, and every control character but the line break and the tab. Those can make a line read as something
 * it is not, and a quote carries them into a comment posted under the person's name.
 */
export function cleanText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => (char === '\n' || char === '\t' ? char : ''));
}

/** A path made safe to sit inside a code span: no control or format character, no backtick. */
const pathText = (path: string): string =>
  cleanText(path).replaceAll('`', "'").replaceAll('\n', ' ').trim().slice(0, 300);

/** `src/a.ts:12` or `src/a.ts:10-12`: where a diff selection is. */
export const whereText = (range: DiffRange): string =>
  `${pathText(range.path)}:${range.startLine < range.line ? `${String(range.startLine)}-${String(range.line)}` : String(range.line)}${
    range.side === 'left' ? ' (old side)' : ''
  }`;

/** A quote as Markdown: every line behind `> `, a diff selection headed by where it is. */
export function quoteOf(selected: string, range?: DiffRange): string {
  let text = cleanText(selected.slice(0, MAX_READ_CHARS)).trim();
  if (text === '') return '';
  const cut = text.length > MAX_QUOTE_CHARS;
  if (cut) text = text.slice(0, MAX_QUOTE_CHARS);
  // A pair cut in the middle would leave half a character.
  if (/[\ud800-\udbff]$/u.test(text)) text = text.slice(0, -1);
  const lines = text.split('\n').map(line => (line === '' ? '>' : `> ${line}`));
  const head = range === undefined ? [] : [`> \`${whereText(range)}\``, '>'];
  return [...head, ...lines, ...(cut ? ['>', '> …(quote shortened)'] : [])].join('\n');
}

/** A quote added to a draft: after what is there, with a blank line between, and the cursor's line left empty. */
export const withQuote = (draft: string, quote: string): string =>
  quote === '' ? draft : `${draft.trim() === '' ? '' : `${draft.replace(/\s+$/u, '')}\n\n`}${quote}\n\n`;
