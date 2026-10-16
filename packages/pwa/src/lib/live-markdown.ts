/**
 * THE LIVE MARKDOWN EDITOR'S READING OF A DRAFT — which line is a heading, a list item, a quote or
 * code, and which characters of a line are bold, italic, code, struck through, a link or a reference.
 *
 * The composer's two formatting editor styles (Markdown, Notion-style and Rich text) edit the markdown
 * SOURCE itself: every character the reader typed stays in the document, so what is sent is exactly
 * what was typed and a caret offset means the same thing to the editor, to Vim and to the reference
 * autocomplete. This module only describes that source as data — lines, markers and styled runs — so
 * the editor can paint `# ` lines big and `**x**` bold without the text ever changing underneath.
 *
 * LOSSLESS by construction: for every line, `indent + marker + runs` concatenate back to the line, and
 * the lines joined with `\n` are the draft. BEST-EFFORT semantics: this reads a draft mid-keystroke,
 * so an unclosed fence is code to the end, a lone `*` is text, and nothing here ever throws.
 *
 * It also owns the block-level edits the Rich text toolbar and the Notion-style Backspace make, as
 * pure `DraftEdit`s over the same text.
 */

import { type DraftEdit, toggleWrap } from './composer-editing.ts';
import { findReferences } from './references.ts';

/** What a whole line is. `fence` is a ``` line itself; `code` is a line inside a fence. */
type LiveBlockKind =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'check'
  | 'quote'
  | 'hr'
  | 'fence'
  | 'code';

/** How a run of characters inside a line is painted. */
type LiveRunStyle = 'strong' | 'em' | 'strike' | 'code' | 'link' | 'url' | 'reference';

/** One run of a line's content. `mark` runs are syntax (`**`, a backtick, `](`) rather than words. */
export interface LiveRun {
  readonly text: string;
  readonly style: LiveRunStyle | null;
  readonly mark: boolean;
  /** Offset of the run's first character within the whole draft. */
  readonly start: number;
  /** The inline construct this run belongs to, so a caret inside it can reveal its marks; `-1` for plain text. */
  readonly token: number;
  /** Where that construct starts and ends in the draft; equal to the run's own bounds for plain text. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
}

export interface LiveLine {
  readonly kind: LiveBlockKind;
  /** The full line, exactly as typed. */
  readonly text: string;
  /** Offset of the line's first character within the draft. */
  readonly start: number;
  /** Leading whitespace before a list marker; empty for every other kind. */
  readonly indent: string;
  /** The block's syntax prefix (`## `, `- `, `3. `, `- [x] `, `> `), or `''`. */
  readonly marker: string;
  /** A checklist item's state; `false` for every other kind. */
  readonly checked: boolean;
  /** The content after `indent + marker`, as styled runs. */
  readonly runs: readonly LiveRun[];
}

const FENCE = /^\s*(```|~~~)/u;
const HEADING = /^(#{1,6})\s/u;
const CHECK = /^(\s*)((?:[-*+]\s)?\[([ xX])\]\s)/u;
const BULLET = /^(\s*)([-*+]\s)/u;
const ORDERED = /^(\s*)(\d{1,9}[.)]\s)/u;
const QUOTE = /^(>\s?)/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;

/**
 * The inline constructs, tried left to right in one pass. Code first, so nothing inside a code span is
 * read as emphasis; bold before italic, so `**` is never two italics.
 */
const INLINE =
  /(`+)([^`\n]+?)\1|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|~~(?=\S)([^~\n]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])?\*|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

/** Plain text, split around every reference the shared parser finds in it. */
const plainRuns = (text: string, start: number): LiveRun[] => {
  const runs: LiveRun[] = [];
  let cursor = 0;
  const plain = (to: number): void => {
    if (to <= cursor) return;
    const at = start + cursor;
    runs.push({
      text: text.slice(cursor, to),
      style: null,
      mark: false,
      start: at,
      token: -1,
      tokenStart: at,
      tokenEnd: start + to,
    });
  };
  for (const reference of findReferences(text)) {
    plain(reference.start);
    const at = start + reference.start;
    runs.push({
      text: reference.raw,
      style: 'reference',
      mark: false,
      start: at,
      token: -1,
      tokenStart: at,
      tokenEnd: start + reference.end,
    });
    cursor = reference.end;
  }
  plain(text.length);
  return runs;
};

/** One line's content (after its block marker) as styled runs. */
export const inlineRuns = (text: string, start: number): readonly LiveRun[] => {
  const runs: LiveRun[] = [];
  let last = 0;
  let token = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index as number;
    runs.push(...plainRuns(text.slice(last, index), start + last));
    const whole = match[0];
    const tokenStart = start + index;
    const tokenEnd = tokenStart + whole.length;
    const piece = (slice: string, style: LiveRunStyle, mark: boolean, offset: number): void => {
      runs.push({ text: slice, style, mark, start: tokenStart + offset, token, tokenStart, tokenEnd });
    };
    const wrapped = (open: number, style: LiveRunStyle): void => {
      piece(whole.slice(0, open), style, true, 0);
      piece(whole.slice(open, whole.length - open), style, false, open);
      piece(whole.slice(whole.length - open), style, true, whole.length - open);
    };
    const [, ticks, , bold, boldUnderscore, strike, , label] = match;
    if (ticks !== undefined) wrapped(ticks.length, 'code');
    else if (bold !== undefined || boldUnderscore !== undefined) wrapped(2, 'strong');
    else if (strike !== undefined) wrapped(2, 'strike');
    else if (label === undefined) wrapped(1, 'em');
    else {
      piece('[', 'link', true, 0);
      piece(label, 'link', false, 1);
      piece(whole.slice(label.length + 1), 'url', true, label.length + 1);
    }
    token += 1;
    last = index + whole.length;
  }
  runs.push(...plainRuns(text.slice(last), start + last));
  return runs;
};

const literal = (text: string, start: number): readonly LiveRun[] =>
  text === ''
    ? []
    : [{ text, style: null, mark: false, start, token: -1, tokenStart: start, tokenEnd: start + text.length }];

/** One line outside a fence: its kind, its marker and its runs. */
const readLine = (text: string, start: number): LiveLine => {
  const line = (kind: LiveBlockKind, indent: string, marker: string, checked = false): LiveLine => {
    const content = indent.length + marker.length;
    return {
      kind,
      text,
      start,
      indent,
      marker,
      checked,
      runs: kind === 'hr' ? literal(text, start) : inlineRuns(text.slice(content), start + content),
    };
  };
  const heading = HEADING.exec(text);
  if (heading !== null) {
    const level = Math.min((heading[1] as string).length, 3);
    return line(`h${level}` as 'h1' | 'h2' | 'h3', '', heading[0]);
  }
  if (RULE.test(text)) return line('hr', '', '');
  const check = CHECK.exec(text);
  if (check !== null) return line('check', check[1] as string, check[2] as string, check[3] !== ' ');
  const bullet = BULLET.exec(text);
  if (bullet !== null) return line('bullet', bullet[1] as string, bullet[2] as string);
  const ordered = ORDERED.exec(text);
  if (ordered !== null) return line('ordered', ordered[1] as string, ordered[2] as string);
  const quote = QUOTE.exec(text);
  if (quote !== null) return line('quote', '', quote[1] as string);
  return line('p', '', '');
};

/** The whole draft as lines. An unclosed fence makes code of everything after it. */
export const parseLiveMarkdown = (value: string): readonly LiveLine[] => {
  const lines: LiveLine[] = [];
  let start = 0;
  let fence: string | null = null;
  for (const text of value.split('\n')) {
    const opener = FENCE.exec(text);
    if (fence !== null || opener !== null) {
      const closes = fence !== null && opener !== null && opener[1] === fence;
      const opens = fence === null;
      lines.push({
        kind: opens || closes ? 'fence' : 'code',
        text,
        start,
        indent: '',
        marker: '',
        checked: false,
        runs: literal(text, start),
      });
      if (opens) fence = (opener as RegExpExecArray)[1] as string;
      else if (closes) fence = null;
    } else lines.push(readLine(text, start));
    start += text.length + 1;
  }
  return lines;
};

/** The block a toolbar or shortcut can turn lines into. */
export type LiveBlockTarget = 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'check' | 'quote';

const MARKER_FOR: Record<Exclude<LiveBlockTarget, 'ordered'>, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bullet: '- ',
  check: '- [ ] ',
  quote: '> ',
};

/** The lines a selection touches, as `[first, last]` indexes. */
const touched = (lines: readonly LiveLine[], start: number, end: number): readonly [number, number] => {
  const at = (offset: number): number => {
    let index = 0;
    for (const [candidate, line] of lines.entries()) if (line.start <= offset) index = candidate;
    return index;
  };
  return [at(start), at(Math.max(start, end))];
};

/**
 * Turns every line the selection touches into `target`, or back into plain paragraphs when every one
 * of them already is one. Any other block marker on a line is replaced rather than stacked, so a
 * heading made into a list is `- text`, never `- # text`. The caret keeps its place in the words.
 */
export const toggleBlock = (value: string, start: number, end: number, target: LiveBlockTarget): DraftEdit => {
  const lines = parseLiveMarkdown(value);
  const [first, last] = touched(lines, start, end);
  const chosen = lines.slice(first, last + 1);
  const already = chosen.every(line => line.kind === target);
  const from = (lines[first] as LiveLine).start;
  let caret = start;
  let at = from;
  const rewritten = chosen.map((line, index) => {
    const prefix = line.kind === 'fence' || line.kind === 'code' ? 0 : line.indent.length + line.marker.length;
    const marker = already ? '' : target === 'ordered' ? `${index + 1}. ` : MARKER_FOR[target];
    const text = marker + line.text.slice(prefix);
    // The caret keeps its place in the line's words, wherever the new marker leaves them.
    if (index === 0 || start >= line.start) caret = at + marker.length + Math.max(start - line.start - prefix, 0);
    at += text.length + 1;
    return text;
  });
  const lastLine = lines[last] as LiveLine;
  const next = value.slice(0, from) + rewritten.join('\n') + value.slice(lastLine.start + lastLine.text.length);
  return { value: next, caret };
};

/** Wraps the lines a selection touches in a ``` fence, with the caret inside it. */
export const wrapCodeBlock = (value: string, start: number, end: number): DraftEdit => {
  const lines = parseLiveMarkdown(value);
  const [first, last] = touched(lines, start, end);
  const from = (lines[first] as LiveLine).start;
  const lastLine = lines[last] as LiveLine;
  const to = lastLine.start + lastLine.text.length;
  const body = value.slice(from, to);
  const next = `${value.slice(0, from)}\`\`\`\n${body}\n\`\`\`${value.slice(to)}`;
  return { value: next, caret: from + 4 + body.length };
};

/**
 * NOTION'S BACKSPACE: at the very start of a heading's, a list item's or a quote's words, Backspace
 * turns the block back into a paragraph — the whole marker goes, not one `#` of it. Answers `null`
 * anywhere else, so the key keeps its ordinary meaning.
 */
export const removeBlockMarker = (value: string, caret: number): DraftEdit | null => {
  const line = parseLiveMarkdown(value).find(
    candidate => caret >= candidate.start && caret <= candidate.start + candidate.text.length,
  ) as LiveLine;
  if (line.marker === '' || caret !== line.start + line.indent.length + line.marker.length) return null;
  return {
    value: value.slice(0, line.start) + value.slice(line.start + line.indent.length + line.marker.length),
    caret: line.start,
  };
};

/** One formatting action, from the Rich text toolbar or a ⌘/Ctrl shortcut in either formatting style. */
export type FormatCommand =
  | { readonly kind: 'wrap'; readonly marker: '**' | '*' | '`' | '~~' }
  | { readonly kind: 'block'; readonly target: LiveBlockTarget }
  | { readonly kind: 'codeBlock' };

/** A format command as an edit of the draft: marks wrap (or unwrap) the selection, blocks rewrite its lines. */
export const applyFormat = (value: string, start: number, end: number, command: FormatCommand): DraftEdit => {
  if (command.kind === 'wrap') return toggleWrap(value, start, end, command.marker);
  if (command.kind === 'block') return toggleBlock(value, start, end, command.target);
  return wrapCodeBlock(value, start, end);
};

/** The slice of a key event a shortcut is read from. `code` is the physical key, so ⇧7 is 7 on any layout. */
export interface FormatKey {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const SHIFTED_BLOCKS: Readonly<Record<string, LiveBlockTarget>> = {
  Digit7: 'ordered',
  Digit8: 'bullet',
  Digit9: 'quote',
};

const ALT_BLOCKS: Readonly<Record<string, LiveBlockTarget>> = { Digit1: 'h1', Digit2: 'h2', Digit3: 'h3' };

/**
 * What a ⌘/Ctrl shortcut formats, or `null` when the key is not a formatting shortcut (the caller has
 * already checked ⌘/Ctrl is held). ⌘B bold, ⌘I italic, ⌘E code, ⌘⇧X strike, ⌘⇧7 / ⌘⇧8 numbered and
 * bulleted lists, ⌘⇧9 quote, ⌘⌥1–3 headings, ⌘⌥C a code block.
 */
export const formatShortcut = (event: FormatKey): FormatCommand | null => {
  const key = event.key.toLowerCase();
  if (event.altKey && !event.shiftKey) {
    if (event.code === 'KeyC') return { kind: 'codeBlock' };
    const heading = ALT_BLOCKS[event.code ?? ''];
    return heading === undefined ? null : { kind: 'block', target: heading };
  }
  if (event.altKey) return null;
  if (event.shiftKey) {
    if (key === 'x') return { kind: 'wrap', marker: '~~' };
    const block = SHIFTED_BLOCKS[event.code ?? ''];
    return block === undefined ? null : { kind: 'block', target: block };
  }
  if (key === 'b') return { kind: 'wrap', marker: '**' };
  if (key === 'i') return { kind: 'wrap', marker: '*' };
  if (key === 'e') return { kind: 'wrap', marker: '`' };
  return null;
};
