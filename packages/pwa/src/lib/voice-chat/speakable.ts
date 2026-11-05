/**
 * MARKDOWN → WHAT IS SAID ALOUD. The pure half of "Read aloud" (`docs/voice.md`, F137 slice 1).
 *
 * A reply is written for eyes: code fences, tables, pictures, links and references are all fine on a
 * screen and all awful in a voice. This turns the markdown into a short list of **segments** — one
 * sentence, list item or description each — that a speaker reads in order, and that the chat highlights
 * as captions while they are read.
 *
 * WHAT IS READ, WHAT IS DESCRIBED
 *
 *   paragraphs, headings, list items   read, a sentence at a time (a list of more than 8 reads 5, then "and N more")
 *   bold, italic, strikethrough        the plain words
 *   `inline code`                      read when short and word-like ("use dictation"), a file path as its
 *                                      file name, otherwise "a code snippet" — never a symbol soup
 *   code fence                         "Code block, 14 lines of TypeScript. It's on screen." — never the code
 *   table                              "A table with 4 rows. Columns: name, status, cost."
 *   fy-render block                    its required `alt`: "A diagram: login flow from browser to daemon."
 *   image                              "An image: {alt}"
 *   [link](url) · bare URL             the link text · "a link to github.com"
 *   @file · :agent · &F12 · !A3 · …    "file.ts" · "ferret dev" · "task F12" · "agenda item A3" (the one
 *                                      reference grammar, `lib/references.ts`, so nothing is parsed twice)
 *   commit hashes · UUIDs              "a commit" · "an ID"
 *   emoji · HTML                       dropped · stripped
 *   quote                              "Quote:" then the words
 *
 * ONE READING IS CAPPED at about a minute (≈ 900 characters at normal speed): past that it says
 * "There's more on screen." and stops, so a long reply never becomes a lecture.
 *
 * TOTAL. Any string — empty, huge, half-typed markup, lone surrogates — returns a reading and never
 * throws; a failure inside returns a single "on screen" segment rather than silence or a crash. Pure:
 * no DOM, no clock, no storage, and nothing here logs or keeps the text it is given.
 *
 * `sourceRange` is the span of the ORIGINAL markdown the segment came from (the whole block for a
 * sentence in it): a caption highlights by segment, and the range is what a future surface uses to
 * point back at the source.
 */

import { parseFyRender } from '../fy-render.ts';
import { findReferences, parseReferenceToken, type Reference } from '../references.ts';

type SpeakableKind = 'text' | 'heading' | 'list' | 'quote' | 'code' | 'table' | 'diagram' | 'image' | 'more';

interface SpeakableSegment {
  /** What is said — plain words, ending in punctuation so the voice pauses. */
  readonly text: string;
  /** Where in the original markdown this came from: `[start, end)` character offsets. */
  readonly sourceRange: { readonly start: number; readonly end: number };
  readonly kind: SpeakableKind;
}

export interface SpeakableReading {
  readonly segments: readonly SpeakableSegment[];
  /** True when the reply was longer than one reading: the last segment says there is more on screen. */
  readonly truncated: boolean;
}

export interface SpeakableOptions {
  /** The most characters one reading speaks before "There's more on screen." */
  readonly maxCharacters?: number;
}

/** About one minute of speech at normal speed. */
export const READING_CHARACTERS_PER_MINUTE = 900;
export const MORE_ON_SCREEN = "There's more on screen.";
/** Past this many list items, read the first few and count the rest. */
const LIST_READ_ALL_UP_TO = 8;
const LIST_READ_FIRST = 5;
const TABLE_COLUMNS_NAMED = 6;
/** Nothing past this is scanned: a reading never needs it, and a megabyte of markdown is not a reply. */
const SCAN_LIMIT = 100_000;
const DESCRIPTION_LIMIT = 200;
const CODE_SPAN_SPOKEN_LIMIT = 24;

/** How much one reading may say at a given speed: faster speech fits more words into the same minute. */
export const readingCapCharacters = (rate: number): number => {
  const bounded = Number.isFinite(rate) ? Math.min(2, Math.max(0.8, rate)) : 1;
  return Math.round(READING_CHARACTERS_PER_MINUTE * bounded);
};

interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface Block {
  readonly kind: SpeakableKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const toLines = (source: string): Line[] => {
  const lines: Line[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    lines.push({ text: source.slice(start, end).replace(/\r$/u, ''), start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
};

/** Blank out `<!-- … -->` while keeping every offset and newline where they were. */
const maskComments = (source: string): string =>
  source.replace(/<!--[\s\S]*?(?:-->|$)/gu, comment => comment.replace(/[^\n]/gu, ' '));

// ---------------------------------------------------------------------------------------------------
// Inline text → words
// ---------------------------------------------------------------------------------------------------

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  py: 'Python',
  python: 'Python',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go',
  css: 'CSS',
  html: 'HTML',
  md: 'Markdown',
  markdown: 'Markdown',
  sql: 'SQL',
  nix: 'Nix',
  toml: 'TOML',
  diff: 'diff',
};

const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])/gu;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const COMMIT = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/giu;
const LONG_HEX = /\b[0-9a-f]{41,128}\b/giu;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;
const PLACEHOLDER = /\uE000(\d+)\uE000/gu;

const hostOf = (url: string): string => {
  const host = url.replace(/^https?:\/\//iu, '').split(/[/?#]/u)[0] ?? '';
  return host.replace(/^www\./iu, '').replace(/:\d+$/u, '');
};

const basename = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
};

const spokenReference = (reference: Reference): string => {
  switch (reference.kind) {
    case 'agent':
      return `ferret ${reference.name}`;
    case 'task':
      return `task ${reference.id}`;
    case 'attention':
      return `agenda item ${String(reference.id).replace(/^!/u, '')}`;
    case 'surface':
      return `${reference.surface} ${reference.key}`;
    case 'skill':
      return `skill ${reference.name}`;
    case 'file':
      return basename(reference.path);
  }
};

/** `useDictation` → "use dictation", `fy-render` → "fy render", `package.json` → "package dot json". */
const wordsOf = (token: string): string =>
  token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .replace(/\./gu, ' dot ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

const WORD_LIKE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;
const PATH_LIKE = /^[^\s`]*[/][^\s`]*[\p{L}\p{N}_+@#-]$/u;

const spokenCodeSpan = (code: string): string => {
  const content = code.trim();
  if (content === '') return '';
  const reference = parseReferenceToken(content);
  if (reference !== null) return spokenReference(reference);
  const path = content.replace(/^\.?\/*/u, '').replace(/:\d+(?:-\d+)?$/u, '');
  if (PATH_LIKE.test(path) && content.length <= 120) return basename(path);
  if (content.length <= CODE_SPAN_SPOKEN_LIMIT && WORD_LIKE.test(content)) return wordsOf(content);
  return 'a code snippet';
};

const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 31 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000)
        ? String.fromCodePoint(code)
        : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

const replaceReferences = (text: string): string => {
  const found = findReferences(text);
  let out = text;
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const match = found[index];
    if (match === undefined) continue;
    out = `${out.slice(0, match.start)}${spokenReference(match.reference)}${out.slice(match.end)}`;
  }
  return out;
};

/** One run of inline markdown as the words a person would say. Never throws; may return ''. */
export const speakInline = (raw: string): string => {
  const protectedWords: string[] = [];
  const protect = (words: string): string => {
    protectedWords.push(words);
    return `\uE000${protectedWords.length - 1}\uE000`;
  };
  let text = raw.replace(/\uE000/gu, ' ');
  // Code spans first, and set aside: nothing below may read inside them.
  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/gu, (_whole, _ticks: string, code: string) =>
    protect(spokenCodeSpan(code)),
  );
  text = text.replace(/<(https?:\/\/[^>\s]+)>/giu, (_whole, url: string) => protect(`a link to ${hostOf(url)}`));
  text = text.replace(/<\/?[A-Za-z][^>]*>/gu, ' ').replace(/<!--[\s\S]*?-->/gu, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_whole, alt: string) => {
    const described = speakInline(alt);
    return protect(described === '' ? 'an image' : `an image: ${described}`);
  });
  text = text.replace(/\[\^[^\]]*\]/gu, '');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/gu, (_whole, label: string, url: string) =>
    /^https?:\/\//iu.test(label.trim()) ? protect(`a link to ${hostOf(label.trim())}`) : label || hostOf(url),
  );
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1');
  text = text.replace(BARE_URL, (url: string) => {
    const tail = url.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    return `${protect(`a link to ${hostOf(url.slice(0, url.length - tail.length))}`)}${tail}`;
  });
  text = replaceReferences(text);
  text = text
    .replace(UUID, 'an ID')
    .replace(LONG_HEX, 'an ID')
    .replace(COMMIT, 'a commit')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<&])/gu, '$1')
    .replace(/(\*\*|__|~~)/gu, '')
    .replace(/(^|[\s(])[*_]+(?=\S)/gu, '$1')
    .replace(/(?<=\S)[*_]+(?=[\s).,;:!?]|$)/gu, '');
  text = decodeEntities(text).replace(EMOJI, '');
  text = text
    .replace(/\s+/gu, ' ')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .trim();
  return text.replace(PLACEHOLDER, (_whole, index: string) => protectedWords[Number(index)] ?? '');
};

// ---------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'no',
  'fig',
  'approx',
]);
const SENTENCE_END = /[.!?…]+["')\]]*(?=\s)/gu;

/** Split one run of spoken words into sentences, not splitting on "e.g." or before a lowercase word. */
export const sentencesOf = (text: string): string[] => {
  const out: string[] = [];
  let from = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const before = text.slice(from, match.index ?? 0);
    const lastWord = (before.match(/(\S+)$/u)?.[1] ?? '').toLowerCase().replace(/^[("']+/u, '');
    if (match[0].startsWith('.') && ABBREVIATIONS.has(lastWord)) continue;
    const next = text.slice(end).trimStart()[0];
    if (next !== undefined && /\p{Ll}/u.test(next)) continue;
    out.push(text.slice(from, end).trim());
    from = end;
  }
  const rest = text.slice(from).trim();
  if (rest !== '') out.push(rest);
  return out.filter(sentence => sentence !== '');
};

const TERMINAL = /[.!?:;…]["')\]]*$/u;
const ended = (text: string): string => (TERMINAL.test(text) ? text : `${text}.`);

// ---------------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------------

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/u;
const HEADING = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/u;
const RULE = /^\s{0,3}(?:([-*_])(?:\s*\1){2,}|=+)\s*$/u;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const TASK_BOX = /^\[[ xX]\]\s+/u;

const describeFyRender = (body: string): string | null => {
  const parsed = parseFyRender(body);
  if (!parsed.ok) return null;
  const { type, alt } = parsed.block;
  const said = speakInline(alt).slice(0, DESCRIPTION_LIMIT);
  const label: Readonly<Record<string, string>> = {
    mermaid: 'A diagram',
    svg: 'An illustration',
    html: 'An interactive page',
    chart: 'A chart',
    map: 'A map',
    image: 'An image',
    video: 'A video',
    audio: 'An audio clip',
    pdf: 'A PDF',
    lottie: 'An animation',
    card: 'A card',
    board: 'A board',
  };
  const name = label[type] ?? 'A picture';
  return said === '' ? `${name}. It's on screen.` : `${name}: ${ended(said)}`;
};

const describeCode = (info: string, body: readonly string[]): string => {
  const lines = body.length > 0 && (body[body.length - 1] ?? '').trim() === '' ? body.length - 1 : body.length;
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  const key = info.toLowerCase().replace(/[^a-z0-9+#-]/gu, '');
  const language = LANGUAGE_NAMES[key] ?? (key !== '' && key.length <= 16 ? key : '');
  return `Code block, ${count}${language === '' ? '' : ` of ${language}`}. It's on screen.`;
};

const describeTable = (rows: readonly string[]): string => {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split(/(?<!\\)\|/u)
      .map(cell => speakInline(cell))
      .filter(cell => cell !== '');
  const body = Math.max(0, rows.length - 2);
  const columns = cells(rows[0] ?? '');
  const named = columns.slice(0, TABLE_COLUMNS_NAMED).join(', ');
  const more = columns.length > TABLE_COLUMNS_NAMED ? `, and ${columns.length - TABLE_COLUMNS_NAMED} more` : '';
  const head = `A table with ${body} ${body === 1 ? 'row' : 'rows'}.`;
  return named === '' ? `${head} It's on screen.` : `${head} Columns: ${named}${more}.`;
};

const blocksOf = (source: string): Block[] => {
  const lines = toLines(source);
  const blocks: Block[] = [];
  let paragraph: Line[] = [];
  let items: { text: string; start: number; end: number }[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const first = paragraph[0] as Line;
    const last = paragraph[paragraph.length - 1] as Line;
    const joined = paragraph.map(line => line.text.trim()).join(' ');
    paragraph = [];
    const image = joined.match(/^!\[([^\]]*)\]\([^)]*\)$/u);
    if (image !== null) {
      const alt = speakInline(image[1] ?? '');
      blocks.push({
        kind: 'image',
        text: alt === '' ? "An image. It's on screen." : `An image: ${ended(alt)}`,
        start: first.start,
        end: last.end,
      });
      return;
    }
    const words = speakInline(joined);
    if (words !== '') blocks.push({ kind: 'text', text: words, start: first.start, end: last.end });
  };

  const flushList = (): void => {
    if (items.length === 0) return;
    const spoken = items
      .map(item => ({ ...item, words: speakInline(item.text.replace(TASK_BOX, '')) }))
      .filter(item => item.words !== '');
    items = [];
    const shown = spoken.length > LIST_READ_ALL_UP_TO ? spoken.slice(0, LIST_READ_FIRST) : spoken;
    for (const item of shown) blocks.push({ kind: 'list', text: item.words, start: item.start, end: item.end });
    if (spoken.length > shown.length) {
      const hidden = spoken.length - shown.length;
      const end = spoken[spoken.length - 1]?.end ?? 0;
      blocks.push({ kind: 'list', text: `and ${hidden} more.`, start: end, end });
    }
  };

  let at = 0;
  while (at < lines.length) {
    const line = lines[at] as Line;
    const text = line.text;

    if (text.trim() === '') {
      flushParagraph();
      // A blank line ends a list unless the list carries on right after it.
      if (items.length > 0) {
        let peek = at + 1;
        while (peek < lines.length && (lines[peek]?.text ?? '').trim() === '') peek += 1;
        const next = lines[peek]?.text ?? '';
        if (!(LIST_ITEM.test(next) || /^\s{2,}\S/u.test(next))) flushList();
      }
      at += 1;
      continue;
    }

    const fence = text.match(FENCE_OPEN);
    if (fence !== null) {
      flushParagraph();
      flushList();
      const marker = (fence[1] as string)[0] as string;
      const width = (fence[1] as string).length;
      const closer = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${width},}\\s*$`, 'u');
      const body: string[] = [];
      let scan = at + 1;
      while (scan < lines.length && !closer.test(lines[scan]?.text ?? '')) {
        body.push(lines[scan]?.text ?? '');
        scan += 1;
      }
      const lastLine = lines[Math.min(scan, lines.length - 1)] as Line;
      const info = fence[2] ?? '';
      const described = info.toLowerCase() === 'fy-render' ? describeFyRender(body.join('\n')) : null;
      blocks.push({
        kind: described === null ? 'code' : 'diagram',
        text: described ?? describeCode(info.toLowerCase() === 'fy-render' ? '' : info, body),
        start: line.start,
        end: lastLine.end,
      });
      at = scan + 1;
      continue;
    }

    const rowAfter = lines[at + 1]?.text ?? '';
    if (text.includes('|') && rowAfter.includes('|') && TABLE_DIVIDER.test(rowAfter)) {
      flushParagraph();
      flushList();
      const rows: string[] = [];
      let scan = at;
      while (
        scan < lines.length &&
        (lines[scan]?.text ?? '').trim() !== '' &&
        (lines[scan]?.text ?? '').includes('|')
      ) {
        rows.push(lines[scan]?.text ?? '');
        scan += 1;
      }
      blocks.push({ kind: 'table', text: describeTable(rows), start: line.start, end: (lines[scan - 1] as Line).end });
      at = scan;
      continue;
    }

    const heading = text.match(HEADING);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const words = speakInline(heading[1] ?? '');
      if (words !== '') blocks.push({ kind: 'heading', text: words, start: line.start, end: line.end });
      at += 1;
      continue;
    }

    if (RULE.test(text)) {
      flushParagraph();
      flushList();
      at += 1;
      continue;
    }

    if (QUOTE.test(text)) {
      flushParagraph();
      flushList();
      const quoted: string[] = [];
      let scan = at;
      while (scan < lines.length && QUOTE.test(lines[scan]?.text ?? '')) {
        quoted.push((lines[scan]?.text ?? '').replace(QUOTE, '$1'));
        scan += 1;
      }
      const words = speakInline(quoted.join(' '));
      if (words !== '')
        blocks.push({ kind: 'quote', text: `Quote: ${words}`, start: line.start, end: (lines[scan - 1] as Line).end });
      at = scan;
      continue;
    }

    const item = text.match(LIST_ITEM);
    if (item !== null) {
      flushParagraph();
      items.push({ text: item[2] ?? '', start: line.start, end: line.end });
      at += 1;
      continue;
    }

    if (items.length > 0 && /^\s{2,}\S/u.test(text)) {
      // A wrapped line of the item above it.
      const open = items[items.length - 1];
      if (open !== undefined) {
        open.text = `${open.text} ${text.trim()}`;
        open.end = line.end;
      }
      at += 1;
      continue;
    }

    flushList();
    paragraph.push(line);
    at += 1;
  }
  flushParagraph();
  flushList();
  return blocks;
};

// ---------------------------------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------------------------------

const segmentsOf = (blocks: readonly Block[]): SpeakableSegment[] => {
  const out: SpeakableSegment[] = [];
  for (const block of blocks) {
    const range = { start: block.start, end: block.end };
    // Only prose is cut into sentences; a description or a list item is one thing to say and to highlight.
    const parts = block.kind === 'text' || block.kind === 'quote' ? sentencesOf(block.text) : [block.text];
    for (const part of parts) out.push({ text: ended(part), sourceRange: range, kind: block.kind });
  }
  return out;
};

const cutAtWord = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const space = slice.lastIndexOf(' ');
  return (space > limit / 2 ? slice.slice(0, space) : slice).replace(/[\s,;:-]+$/u, '');
};

/**
 * The segments one reading says, in order. Always a value, never a throw. Empty `segments` means there
 * is nothing worth saying (blank, or markup with no words).
 */
export function speakableSegments(markdown: string, options: SpeakableOptions = {}): SpeakableReading {
  try {
    const source = typeof markdown === 'string' ? markdown : '';
    const limit = options.maxCharacters ?? READING_CHARACTERS_PER_MINUTE;
    const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : READING_CHARACTERS_PER_MINUTE;
    const scanned = source.length > SCAN_LIMIT ? source.slice(0, SCAN_LIMIT) : source;
    const all = segmentsOf(blocksOf(maskComments(scanned)));

    const out: SpeakableSegment[] = [];
    let used = 0;
    let truncated = scanned.length < source.length;
    for (const segment of all) {
      if (out.length > 0 && used + segment.text.length + 1 > cap) {
        truncated = true;
        break;
      }
      if (out.length === 0 && segment.text.length > cap) {
        out.push({ ...segment, text: ended(cutAtWord(segment.text, cap)) });
        truncated = true;
        break;
      }
      out.push(segment);
      used += segment.text.length + 1;
    }
    if (!truncated) return { segments: out, truncated: false };
    const end = out[out.length - 1]?.sourceRange.end ?? 0;
    return {
      segments: [...out, { text: MORE_ON_SCREEN, sourceRange: { start: end, end: source.length }, kind: 'more' }],
      truncated: true,
    };
  } catch {
    // A reply the reader cannot make sense of is still on screen, so say that rather than nothing.
    return {
      segments: [{ text: 'This reply is on screen.', sourceRange: { start: 0, end: 0 }, kind: 'more' }],
      truncated: true,
    };
  }
}
