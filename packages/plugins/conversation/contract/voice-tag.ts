/**
 * THE `<voice>` TAG: how a reply marks the words that are SPOKEN (voice mode, `docs/voice.md`). One grammar, read by
 * everything that has to agree on what a spoken line is: the transcript draws each one as a speaker line, and Read aloud
 * and Auto-read say only those lines when a reply has any. The parser lives here, in Conversation's contract, because the
 * chat is who first meets the text and Voice imports it (as it imports Conversation's other grammars).
 *
 * THE GRAMMAR
 *
 *   `<voice>words</voice>`      a spoken line: exactly those two tags, lower case, no attributes. The words are read as
 *                               plain text, white space folded to single spaces.
 *   nothing between the tags    no line: the tags go, nothing is drawn or said.
 *   a tag inside code           text, never a line: a fenced block (``` or ~~~), an indented block, or an inline `code span`
 *                               is the reader's own example of the tag, so a reply that TEACHES the tag is not a spoken one.
 *   a blank line or a fence     ends a line: `<voice>` may not run across a paragraph or a code block. If the closing
 *                               tag is not in the same paragraph, the opening tag is unclosed.
 *   nested `<voice>`            one line: the first closing tag ends it and the inner opening tags are dropped.
 *   `</voice>` with no opening  text.
 *   unclosed `<voice>`          text, EXCEPT at the very end of the message (`open`): that is a line still arriving, which
 *                               the page may draw as it grows and the voice never says.
 *
 * PURE AND TOTAL. Any string — empty, huge, half-typed, lone surrogates — returns pieces and never throws. Every scan is a
 * single left-to-right pass (the code spans are paired with a lookup table, not a rescan), so a message of a hundred
 * thousand backticks or open tags costs about what a message of words does. Nothing here keeps or logs the text.
 */

/** A stretch of the message that is not a spoken line. `start`/`end` are UTF-16 offsets of the source. */
export interface VoiceTextPiece {
  readonly kind: 'text';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * One spoken line. `text` is the words (folded, never empty); `start`/`end` span the tags and the words in the source and
 * `contentStart` is where the words begin. `open` is true for a line that has no closing tag YET (the tail of a message
 * still streaming): it is drawn, never spoken.
 */
export interface VoiceLinePiece {
  readonly kind: 'voice';
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly open: boolean;
}

export type VoicePiece = VoiceTextPiece | VoiceLinePiece;

export const VOICE_OPEN_TAG = '<voice>';
export const VOICE_CLOSE_TAG = '</voice>';

interface Range {
  readonly start: number;
  readonly end: number;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/u;
const INDENTED_CODE_LINE = /^(?: {4}|\t)/u;

/** One line of the source: where it starts, where its text ends (before the newline) and the line itself. */
const linesOf = (source: string): readonly { readonly start: number; readonly end: number }[] => {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    lines.push({ start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
};

/**
 * The fenced and indented code of the message, and the blank lines, as ranges. `blocks` are the ranges a spoken line may
 * never touch (code and fence lines); `paragraphs` are the runs of ordinary lines between them, each its own span for
 * inline code.
 */
const structureOf = (source: string): { readonly blocks: Range[]; readonly paragraphs: Range[] } => {
  const blocks: Range[] = [];
  const paragraphs: Range[] = [];
  let paragraphStart = -1;
  let paragraphEnd = -1;
  let fence: { readonly char: string; readonly length: number; readonly start: number } | null = null;
  let previousBlank = true;
  const endParagraph = (): void => {
    if (paragraphStart !== -1) paragraphs.push({ start: paragraphStart, end: paragraphEnd });
    paragraphStart = -1;
  };
  for (const { start, end } of linesOf(source)) {
    const line = source.slice(start, end);
    if (fence !== null) {
      // A closing fence: the same character, at least as long, nothing else on the line.
      const closing = FENCE_LINE.exec(line);
      const marker = closing?.[1] ?? '';
      if (marker.startsWith(fence.char) && marker.length >= fence.length && line.trim() === marker) {
        blocks.push({ start: fence.start, end });
        fence = null;
      }
      previousBlank = false;
      continue;
    }
    const opening = FENCE_LINE.exec(line);
    if (opening !== null) {
      endParagraph();
      const marker = opening[1] ?? '';
      // A backtick fence's info string may not hold a backtick (that is an inline span, not a fence).
      if (marker.startsWith('`') && line.slice(opening[0].length).includes('`')) {
        paragraphStart = paragraphStart === -1 ? start : paragraphStart;
        paragraphEnd = end;
        previousBlank = false;
        continue;
      }
      fence = { char: marker.charAt(0), length: marker.length, start };
      previousBlank = false;
      continue;
    }
    if (line.trim() === '') {
      endParagraph();
      previousBlank = true;
      continue;
    }
    // Indented code needs a blank line (or the start) before it: it cannot interrupt a paragraph.
    if (INDENTED_CODE_LINE.test(line) && (previousBlank || paragraphStart === -1)) {
      endParagraph();
      blocks.push({ start, end });
      previousBlank = false;
      continue;
    }
    if (paragraphStart === -1) paragraphStart = start;
    paragraphEnd = end;
    previousBlank = false;
  }
  // A fence the message ends inside is code to the end (and a line still arriving inside it is not a spoken one).
  if (fence !== null) blocks.push({ start: fence.start, end: source.length });
  endParagraph();
  return { blocks, paragraphs };
};

/** The inline code spans of one paragraph: backtick runs paired by length, linear (each run looks up its next twin). */
const codeSpansIn = (source: string, { start, end }: Range): Range[] => {
  const runs: { at: number; length: number }[] = [];
  for (let index = source.indexOf('`', start); index !== -1 && index < end; ) {
    let stop = index;
    while (stop < end && source.charCodeAt(stop) === 96) stop += 1;
    runs.push({ at: index, length: stop - index });
    index = source.indexOf('`', stop);
  }
  const twin = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let run = runs.length - 1; run >= 0; run -= 1) {
    const length = runs[run]?.length ?? 0;
    twin[run] = nextOfLength.get(length) ?? -1;
    nextOfLength.set(length, run);
  }
  const spans: Range[] = [];
  for (let run = 0; run < runs.length; ) {
    const closing = twin[run] ?? -1;
    const opener = runs[run];
    const closer = closing === -1 ? undefined : runs[closing];
    if (opener === undefined || closer === undefined) {
      run += 1;
      continue;
    }
    spans.push({ start: opener.at, end: closer.at + closer.length });
    run = closing + 1;
  }
  return spans;
};

/** Where code is: the ranges (sorted, not overlapping) no tag in them counts. */
const protectedRanges = (source: string): Range[] => {
  const { blocks, paragraphs } = structureOf(source);
  const spans = paragraphs.flatMap(paragraph => codeSpansIn(source, paragraph));
  return [...blocks, ...spans].sort((left, right) => left.start - right.start);
};

const fold = (words: string): string => words.replace(/\s+/gu, ' ').trim();

const textPiece = (source: string, start: number, end: number): VoiceTextPiece[] =>
  end > start ? [{ kind: 'text', text: source.slice(start, end), start, end }] : [];

/**
 * The message cut into text and spoken lines, in order and covering the whole of it except the tags themselves and the
 * words of an empty line. Always a value, never a throw.
 */
export function splitVoice(source: string): readonly VoicePiece[] {
  try {
    const message = typeof source === 'string' ? source : '';
    if (!message.includes(VOICE_OPEN_TAG)) return textPiece(message, 0, message.length);
    const code = protectedRanges(message);
    // A cursor over the sorted ranges: `inCode(at)` moves forward only, so the whole walk is one pass.
    let cursor = 0;
    const codeAt = (at: number): Range | undefined => {
      while (cursor < code.length && (code[cursor]?.end ?? 0) <= at) cursor += 1;
      const range = code[cursor];
      return range !== undefined && range.start <= at ? range : undefined;
    };
    const opaque = (start: number, end: number): boolean => code.some(range => range.start < end && range.end > start);
    const pieces: VoicePiece[] = [];
    let copied = 0;
    let at = 0;
    while (at < message.length) {
      const open = message.indexOf(VOICE_OPEN_TAG, at);
      if (open === -1) break;
      const inCode = codeAt(open);
      if (inCode !== undefined) {
        at = inCode.end;
        continue;
      }
      const contentStart = open + VOICE_OPEN_TAG.length;
      // The closing tag: the first one outside code, in the same paragraph (no blank line and no code between).
      let close = message.indexOf(VOICE_CLOSE_TAG, contentStart);
      for (let inside = close === -1 ? undefined : codeAt(close); inside !== undefined; inside = codeAt(close)) {
        close = message.indexOf(VOICE_CLOSE_TAG, inside.end);
        if (close === -1) break;
      }
      const sameParagraph = (end: number): boolean =>
        !/\n[ \t]*\n/u.test(message.slice(contentStart, end)) && !opaque(contentStart, end);
      const closed = close !== -1 && sameParagraph(close);
      if (!closed) {
        // Unclosed. At the very tail of the message (nothing after it but its own words) it is a line still arriving.
        const tail = message.slice(contentStart);
        const arriving = !/\n[ \t]*\n/u.test(tail) && !opaque(contentStart, message.length);
        if (arriving && close === -1) {
          pieces.push(...textPiece(message, copied, open));
          const words = fold(tail.split(VOICE_OPEN_TAG).join(' '));
          if (words !== '') {
            pieces.push({ kind: 'voice', text: words, start: open, end: message.length, contentStart, open: true });
          }
          copied = message.length;
          at = message.length;
          break;
        }
        at = contentStart;
        continue;
      }
      pieces.push(...textPiece(message, copied, open));
      const words = fold(message.slice(contentStart, close).split(VOICE_OPEN_TAG).join(' '));
      const end = close + VOICE_CLOSE_TAG.length;
      if (words !== '') pieces.push({ kind: 'voice', text: words, start: open, end, contentStart, open: false });
      copied = end;
      at = end;
    }
    pieces.push(...textPiece(message, copied, message.length));
    return pieces.filter(piece => piece.kind === 'voice' || piece.text.trim() !== '');
  } catch {
    // A message the reader cannot make sense of is still a message: show it as it is, say none of it.
    return textPiece(typeof source === 'string' ? source : '', 0, typeof source === 'string' ? source.length : 0);
  }
}

/** The words the voice says: the closed lines of the message, in order. Empty when it has none (nothing is a spoken reply). */
export const spokenLines = (source: string): readonly VoiceLinePiece[] =>
  splitVoice(source).filter((piece): piece is VoiceLinePiece => piece.kind === 'voice' && !piece.open);
