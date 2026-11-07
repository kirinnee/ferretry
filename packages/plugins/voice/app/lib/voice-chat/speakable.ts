/**
 * MARKDOWN → WHAT IS SAID ALOUD. The pure half of "Read aloud" (`docs/voice.md`, F137 slice 1).
 *
 * A reply is written for eyes: code fences, tables, pictures, links and references are all fine on a
 * screen and all awful in a voice. This turns the markdown into a short list of **segments** — one
 * sentence, list item or description each — that a speaker reads in order, and that the chat highlights
 * as captions while they are read.
 *
 * ONE PARSER, THE SCREEN'S. The markdown is parsed by `remark-parse` + `remark-gfm` — the very pair the
 * chat's renderer (`components/markdown.tsx`) draws from — and the segments are made by walking that tree.
 * So what the screen shows as code, a table, a quote or a diagram is what the voice describes, at every
 * depth: a `~~~fy-render` block inside a quote, four-space-indented code and a fence inside a list item
 * are all described, never read. Hand-written line scanning and backtracking regexes over untrusted text
 * are what this replaced: every scan left here is linear, so a reply made of a hundred thousand backticks
 * is as cheap to read as one made of words.
 *
 * WHAT IS READ, WHAT IS DESCRIBED
 *
 *   paragraphs, headings, list items   read, a sentence at a time (a list of more than 8 reads 5, then "and N more")
 *   bold, italic, strikethrough        the plain words
 *   `inline code`                      read when short and word-like ("use dictation"), a file path as its
 *                                      file name, a hash or UUID as "a commit" / "an ID", otherwise
 *                                      "a code snippet" — never a symbol soup
 *   code fence · indented code         "Code block, 14 lines of TypeScript. It's on screen." — never the code
 *   table                              "A table with 4 rows. Columns: name, status, cost."
 *   fy-render block                    its required `alt`: "A diagram: login flow from browser to daemon."
 *   image                              "An image: {alt}"
 *   [link](url) · bare URL             the link text · "a link to github.com"
 *   @file · :agent · &F12 · !A3 · …    "file.ts" · "ferret dev" · "task F12" · "agenda item A3" (the one
 *                                      reference grammar, `lib/references.ts`, so nothing is parsed twice)
 *   commit hashes · UUIDs              "a commit" · "an ID"
 *   emoji · HTML · comments            dropped · tags stripped · dropped
 *   quote                              "Quote:" then the words
 *
 * ONE READING IS CAPPED at about a minute (≈ 900 characters at normal speed): past that it says
 * "There's more on screen." and stops, so a long reply never becomes a lecture.
 *
 * TOTAL. Any string — empty, huge, half-typed markup, lone surrogates — returns a reading and never
 * throws; a failure inside returns a single "on screen" segment rather than silence or a crash. Pure:
 * no DOM, no clock, no storage, and nothing here logs or keeps the text it is given.
 *
 * `sourceRange` is the span of the ORIGINAL markdown (UTF-16 offsets, as `String.slice` counts them) the
 * segment came from (the whole block for a sentence in it): a caption highlights by segment, and the range
 * is what a future surface uses to point back at the source.
 */

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { FY_RENDER_FENCE_LANGUAGE, parseFyRender } from '../../shell-voice.ts';
import { findReferences, parseReferenceToken, type Reference } from '../../shell-voice.ts';

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
/**
 * Nothing past this is scanned. A reading says about a minute of words (≈ 900–1800 characters), so a dozen
 * thousand characters of markdown is far more than it can use — and the parser, linear on prose, is not on
 * every hostile input, so the scan is kept small enough that the worst of them stays cheap.
 */
const SCAN_LIMIT = 12_000;
/** …and no more than this many lines: the parser pays per list item and table row, not per character. */
const SCAN_LINES = 400;
const DESCRIPTION_LIMIT = 200;
const CODE_SPAN_SPOKEN_LIMIT = 24;
const CODE_SPAN_PATH_LIMIT = 120;
/** Containers nested deeper than this are on screen but not read: it bounds the walk, not the reading. */
const MAX_DEPTH = 24;

/** How much one reading may say at a given speed: faster speech fits more words into the same minute. */
export const readingCapCharacters = (rate: number): number => {
  const bounded = Number.isFinite(rate) ? Math.min(2, Math.max(0.8, rate)) : 1;
  return Math.round(READING_CHARACTERS_PER_MINUTE * bounded);
};

/**
 * The cap for a reading limited to `seconds` (null: no limit) at `rate`: a minute is
 * `readingCapCharacters`, so 30 seconds is half of it. No limit leaves only the scan limit, which a
 * reading never needs to go past.
 */
export const readingCapForSeconds = (rate: number, seconds: number | null): number =>
  seconds === null
    ? SCAN_LIMIT
    : !Number.isFinite(seconds) || seconds <= 0
      ? readingCapCharacters(rate)
      : Math.max(1, Math.round((readingCapCharacters(rate) * seconds) / 60));

interface Block {
  readonly kind: SpeakableKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------------

/** The part of an mdast node this file reads — structural, like `lib/remark-table-labels.ts`. */
interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly alt?: string | null;
  readonly url?: string;
  readonly children?: readonly MdNode[];
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
}

const processor = unified().use(remarkParse).use(remarkGfm);
const parse = (source: string): MdNode => processor.parse(source) as unknown as MdNode;

const rangeOf = (node: MdNode): { start: number; end: number } => ({
  start: node.position?.start?.offset ?? 0,
  end: node.position?.end?.offset ?? 0,
});

// ---------------------------------------------------------------------------------------------------
// Taming hostile input
// ---------------------------------------------------------------------------------------------------

/**
 * The parser is linear on prose but not on everything: a run of ten thousand `*`, `_` or `.`, and a line
 * of two thousand nested `- - - -`, each cost it seconds. No reply a person reads has either, so before
 * parsing the excess is overwritten one-for-one — runs with spaces, container markers with an `x` — which
 * keeps every offset (every UTF-16 unit) where it was, so `sourceRange` still slices the original.
 * A few linear passes over the text, and one parse (a second only when the window ends inside a code span).
 */
const MAX_MARK_RUN = 24;
const MAX_CONTAINER_DEPTH = 8;
const MARK_RUN = /([*_.])\1{24,}/gu;
/**
 * Tildes are tamed apart from the rest, because a run of them at the start of a line is a fence delimiter whose
 * LENGTH matters: a 30-tilde fence is only closed by 30 or more, so a 25-tilde line inside it must stay 25.
 * Anywhere else on a line a long run is just text.
 */
const TILDE_RUN = /~{25,}/gu;

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';
const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

/** Where the list and quote markers at the start of the line `[start, end)` sit, in order, and where its content begins. */
const containerPrefix = (
  source: string,
  start: number,
  end: number,
): { readonly markers: number[]; readonly content: number } => {
  const markers: number[] = [];
  let at = start;
  while (at < end) {
    while (isBlank(source[at])) at += 1;
    const char = source[at];
    if (char === '>') {
      markers.push(at);
      at += 1;
      continue;
    }
    if ((char === '-' || char === '+' || char === '*') && isBlank(source[at + 1])) {
      markers.push(at);
      at += 1;
      continue;
    }
    let digits = at;
    while (isDigit(source[digits])) digits += 1;
    if (
      digits > at &&
      digits - at <= 9 &&
      (source[digits] === '.' || source[digits] === ')') &&
      isBlank(source[digits + 1])
    ) {
      markers.push(at);
      at = digits + 1;
      continue;
    }
    break;
  }
  return { markers, content: at };
};

/** Where the line break at or after `from` is (LF, CRLF or a bare CR all end a line), or -1. UTF-16 offsets, as everywhere. */
const lineBreakFrom = (source: string, from: number): number => {
  const lf = source.indexOf('\n', from);
  const cr = source.indexOf('\r', from);
  return lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
};

/** Where the line that holds offset `at` starts: just after the last line break before it. */
const lineStartOf = (source: string, at: number): number =>
  Math.max(source.lastIndexOf('\n', at - 1), source.lastIndexOf('\r', at - 1)) + 1;

/** Where the next line starts, given the line break that ended this one (a CRLF is one break). */
const nextLineStart = (source: string, lineBreak: number): number =>
  lineBreak + (source[lineBreak] === '\r' && source[lineBreak + 1] === '\n' ? 2 : 1);

const shorten = (run: string): string => `${run.slice(0, MAX_MARK_RUN)}${' '.repeat(run.length - MAX_MARK_RUN)}`;

/** Long tilde runs shortened, except a fence delimiter: the first thing on its line, past at most eight markers. */
const tameTildes = (source: string): string => {
  let out = '';
  let copied = 0;
  let lineEnd = -1;
  let content = -1;
  for (const match of source.matchAll(TILDE_RUN)) {
    const at = match.index ?? 0;
    if (at > lineEnd) {
      const start = lineStartOf(source, at);
      const newline = lineBreakFrom(source, at);
      lineEnd = newline === -1 ? source.length : newline;
      const prefix = containerPrefix(source, start, lineEnd);
      content = prefix.markers.length <= MAX_CONTAINER_DEPTH ? prefix.content : -1;
    }
    if (at === content) continue;
    out += `${source.slice(copied, at)}${shorten(match[0])}`;
    copied = at + match[0].length;
  }
  return out + source.slice(copied);
};

const tame = (source: string): string => {
  const runs = tameTildes(source.replace(MARK_RUN, shorten));
  let out = '';
  let copied = 0;
  for (let start = 0; start <= runs.length; ) {
    const newline = lineBreakFrom(runs, start);
    const end = newline === -1 ? runs.length : newline;
    for (const marker of containerPrefix(runs, start, end).markers.slice(MAX_CONTAINER_DEPTH)) {
      out += `${runs.slice(copied, marker)}x`;
      copied = marker + 1;
    }
    if (newline === -1) break;
    start = nextLineStart(runs, newline);
  }
  return out + runs.slice(copied);
};

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
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const COMMIT_SOURCE = '(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}';
const LONG_HEX_SOURCE = '[0-9a-f]{41,128}';
const UUID = new RegExp(`\\b${UUID_SOURCE}\\b`, 'giu');
const COMMIT = new RegExp(`\\b${COMMIT_SOURCE}\\b`, 'giu');
const LONG_HEX = new RegExp(`\\b${LONG_HEX_SOURCE}\\b`, 'giu');
/** A whole code span that is nothing but an identifier. */
const WHOLE_UUID = new RegExp(`^${UUID_SOURCE}$`, 'iu');
const WHOLE_LONG_HEX = new RegExp(`^${LONG_HEX_SOURCE}$`, 'iu');
const WHOLE_COMMIT = new RegExp(`^${COMMIT_SOURCE}$`, 'iu');
const PLACEHOLDER = /(\d+)/gu;
/** A tag stops at the next `<`, so a thousand unclosed `<a` cost one pass, not a thousand. */
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/gu;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const WEB_LABEL = /^(?:https?:\/\/|www\.)/iu;

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

/** Hashes and UUIDs inside prose or a code span: "a commit", "an ID". Order matters: longest first. */
const nameIdentifiers = (text: string): string =>
  text.replace(UUID, 'an ID').replace(LONG_HEX, 'an ID').replace(COMMIT, 'a commit');

const spokenCodeSpan = (code: string): string => {
  const content = code.trim();
  if (content === '') return '';
  // An identifier on its own is an identifier however long it is — before any length rule can call it a snippet.
  if (WHOLE_UUID.test(content) || WHOLE_LONG_HEX.test(content)) return 'an ID';
  if (WHOLE_COMMIT.test(content)) return 'a commit';
  const reference = content.length <= CODE_SPAN_PATH_LIMIT ? parseReferenceToken(content) : null;
  if (reference !== null) return spokenReference(reference);
  const path = content.replace(/^\.?\/*/u, '').replace(/:\d+(?:-\d+)?$/u, '');
  if (content.length <= CODE_SPAN_PATH_LIMIT && PATH_LIKE.test(path)) return basename(path);
  if (content.length <= CODE_SPAN_SPOKEN_LIMIT && WORD_LIKE.test(content)) return wordsOf(nameIdentifiers(content));
  return 'a code snippet';
};

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

/**
 * What marks are left in plain text after the parser has taken the real emphasis: a doubled marker is
 * dropped anywhere, and a lone `*` or `_` is dropped when it hugs a word (an unmatched `*word`), but kept
 * when it stands alone ("a * b"). One pass over each run, so a run of ten thousand is one match.
 */
const dropStrayMarks = (text: string): string =>
  text.replace(/\*\*|__|~~/gu, '').replace(/[*_]+/gu, (run, at: number) => {
    const before = text[at - 1];
    const after = text[at + run.length];
    const opens = (before === undefined || /[\s(]/u.test(before)) && after !== undefined && !/\s/u.test(after);
    const closes = before !== undefined && !/\s/u.test(before) && (after === undefined || /[\s).,;:!?]/u.test(after));
    return opens || closes ? '' : run;
  });

/** Words from text whose markdown is already resolved: identifiers named, strays dropped, spaces tidied. */
const finish = (text: string, kept: readonly string[]): string => {
  const named = nameIdentifiers(replaceReferences(text));
  const tidy = dropStrayMarks(named)
    .replace(EMOJI, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .trim();
  return tidy.replace(PLACEHOLDER, (_whole, index: string) => kept[Number(index)] ?? '');
};

/** Plain text (an image's alt, a table cell already flattened) as words. */
const plainWords = (text: string): string => finish(text.replace(//gu, ' '), []);

const stripHtml = (html: string): string => html.replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ');

/** The text an inline subtree shows, with no speaking rules: used to tell what a link's label says. */
const labelText = (nodes: readonly MdNode[]): string =>
  nodes.length === 1 && nodes[0]?.type === 'text' ? (nodes[0].value ?? '') : '';

interface Inline {
  readonly protect: (words: string) => string;
}

const inlineText = (nodes: readonly MdNode[], inline: Inline, depth: number): string => {
  if (depth > MAX_DEPTH) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += (node.value ?? '').replace(//gu, ' ');
        break;
      case 'inlineCode':
        // Set aside: nothing after this may read inside a code span.
        out += inline.protect(spokenCodeSpan(node.value ?? ''));
        break;
      case 'link': {
        const label = labelText(node.children ?? []).trim();
        out +=
          WEB_LABEL.test(label) && !label.includes(' ')
            ? inline.protect(`a link to ${hostOf(label)}`)
            : inlineText(node.children ?? [], inline, depth + 1) || hostOf(node.url ?? '');
        break;
      }
      case 'image':
      case 'imageReference': {
        const described = plainWords(node.alt ?? '');
        out += inline.protect(described === '' ? 'an image' : `an image: ${described}`);
        break;
      }
      case 'html':
        out += stripHtml(node.value ?? '');
        break;
      case 'break':
        out += ' ';
        break;
      case 'footnoteReference':
        break;
      default:
        out += inlineText(node.children ?? [], inline, depth + 1);
    }
  }
  return out;
};

/** A run of inline nodes as the words a person would say. May be ''. */
const speakNodes = (nodes: readonly MdNode[]): string => {
  const kept: string[] = [];
  const protect = (words: string): string => {
    kept.push(words);
    return `${kept.length - 1}`;
  };
  return finish(inlineText(nodes, { protect }, 0), kept);
};

/** One run of inline markdown as the words a person would say. Never throws; may return ''. */
export const speakInline = (raw: string): string => {
  try {
    const root = parse(raw);
    const words = (root.children ?? []).map(node => speakNodes([node])).filter(piece => piece !== '');
    return words.join(' ');
  } catch {
    return '';
  }
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
/** The longest abbreviation above plus its quote or bracket: any word longer than this is no abbreviation. */
const ABBREVIATION_WINDOW = 12;
/** A sentence ends at a run of marks — and the run must START here, or a long run would be rescanned from every mark. */
const SENTENCE_END = /(?<![.!?…])[.!?…]+["')\]]*(?=\s)/gu;

/** The first character at or after `from` that is not whitespace. */
const nextVisible = (text: string, from: number): string | undefined => {
  let at = from;
  while (at < text.length && /\s/u.test(text[at] as string)) at += 1;
  return text[at];
};

/** Split one run of spoken words into sentences, not splitting on "e.g." or before a lowercase word. */
export const sentencesOf = (text: string): string[] => {
  const out: string[] = [];
  let from = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    const window = text.slice(Math.max(from, at - ABBREVIATION_WINDOW), at);
    const lastWord = (window.split(/\s/u).pop() ?? '').toLowerCase().replace(/^[("']+/u, '');
    if (match[0].startsWith('.') && ABBREVIATIONS.has(lastWord)) continue;
    const next = nextVisible(text, end);
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

const describeCode = (info: string, lines: number): string => {
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  const key = info.toLowerCase().replace(/[^a-z0-9+#-]/gu, '');
  const language = LANGUAGE_NAMES[key] ?? (key !== '' && key.length <= 16 ? key : '');
  return `Code block, ${count}${language === '' ? '' : ` of ${language}`}. It's on screen.`;
};

/** How many lines a code node's text has (LF, CRLF or bare CR ends one), not counting a trailing blank one. */
const lineCount = (code: string): number => {
  if (code === '') return 0;
  let lines = 1;
  for (let at = lineBreakFrom(code, 0); at !== -1; at = lineBreakFrom(code, nextLineStart(code, at))) lines += 1;
  return /[\r\n]$/u.test(code) ? lines - 1 : lines;
};

const describeTable = (table: MdNode): string => {
  const rows = table.children ?? [];
  const body = Math.max(0, rows.length - 1);
  const columns = (rows[0]?.children ?? []).map(cell => speakNodes(cell.children ?? [])).filter(cell => cell !== '');
  const named = columns.slice(0, TABLE_COLUMNS_NAMED).join(', ');
  const more = columns.length > TABLE_COLUMNS_NAMED ? `, and ${columns.length - TABLE_COLUMNS_NAMED} more` : '';
  const head = `A table with ${body} ${body === 1 ? 'row' : 'rows'}.`;
  return named === '' ? `${head} It's on screen.` : `${head} Columns: ${named}${more}.`;
};

/** What a prose paragraph is called where it sits: a sentence in a list item is one thing to say. */
type ProseKind = 'text' | 'quote' | 'list';

const describeFence = (node: MdNode): Pick<Block, 'kind' | 'text'> => {
  // Exactly the renderer's test (`remarkFyRenderFences`): the language, and nothing after it.
  if (node.lang === FY_RENDER_FENCE_LANGUAGE && (node.meta ?? '') === '') {
    const described = describeFyRender(node.value ?? '');
    return described === null
      ? { kind: 'code', text: describeCode('', lineCount(node.value ?? '')) }
      : { kind: 'diagram', text: described };
  }
  return { kind: 'code', text: describeCode(node.lang ?? '', lineCount(node.value ?? '')) };
};

const walk = (node: MdNode, depth: number, prose: ProseKind, out: Block[]): void => {
  if (depth > MAX_DEPTH) return;
  const range = rangeOf(node);
  switch (node.type) {
    case 'paragraph': {
      const children = node.children ?? [];
      const only = children.length === 1 ? children[0] : undefined;
      if (only?.type === 'image') {
        const alt = plainWords(only.alt ?? '');
        out.push({
          kind: 'image',
          text: alt === '' ? "An image. It's on screen." : `An image: ${ended(alt)}`,
          ...range,
        });
        return;
      }
      const words = speakNodes(children);
      if (words !== '') out.push({ kind: prose, text: words, ...range });
      return;
    }
    case 'heading': {
      const words = speakNodes(node.children ?? []);
      if (words !== '') out.push({ kind: 'heading', text: words, ...range });
      return;
    }
    case 'code':
      out.push({ ...describeFence(node), ...range });
      return;
    case 'table':
      out.push({ kind: 'table', text: describeTable(node), ...range });
      return;
    case 'html': {
      const words = speakNodes([node]);
      if (words !== '') out.push({ kind: prose, text: words, ...range });
      return;
    }
    case 'blockquote': {
      const first = out.length;
      for (const child of node.children ?? []) walk(child, depth + 1, 'quote', out);
      const opening = out[first];
      if (opening?.kind === 'quote' && !opening.text.startsWith('Quote:')) {
        out[first] = { ...opening, text: `Quote: ${opening.text}` };
      } else if (opening !== undefined && !(opening.kind === 'quote')) {
        out.splice(first, 0, { kind: 'quote', text: 'Quote:', start: range.start, end: opening.start });
      }
      return;
    }
    case 'list': {
      const items = (node.children ?? [])
        .map(item => {
          const spoken: Block[] = [];
          for (const child of item.children ?? []) walk(child, depth + 1, 'list', spoken);
          return spoken;
        })
        .filter(spoken => spoken.length > 0);
      const shown = items.length > LIST_READ_ALL_UP_TO ? items.slice(0, LIST_READ_FIRST) : items;
      for (const spoken of shown) out.push(...spoken);
      if (items.length > shown.length) {
        const end = items[items.length - 1]?.at(-1)?.end ?? range.end;
        out.push({ kind: 'list', text: `and ${items.length - shown.length} more.`, start: end, end });
      }
      return;
    }
    case 'thematicBreak':
    case 'definition':
      return;
    default:
      // root, footnote definitions, anything a plugin adds: read what is inside.
      for (const child of node.children ?? []) walk(child, depth + 1, prose, out);
  }
};

const blocksOf = (root: MdNode): Block[] => {
  const blocks: Block[] = [];
  walk(root, 0, 'text', blocks);
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

/** The start of `source` a reading can use: at most `SCAN_LIMIT` characters and `SCAN_LINES` lines. */
const scanWindow = (source: string): string => {
  const head = source.length > SCAN_LIMIT ? source.slice(0, SCAN_LIMIT) : source;
  let newline = -1;
  for (let line = 0; line < SCAN_LINES; line += 1) {
    newline = head.indexOf('\n', newline + 1);
    if (newline === -1) return head;
  }
  return head.slice(0, newline);
};

const TEXT_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * Where a code span may have been left open by the cut. The window ends mid-text, so the last paragraph can
 * hold a backtick whose closing partner lies past the cut: the parser then sees plain text and the code
 * between would be SPOKEN. Only the last text block can be in that state (anything followed by another block
 * is complete), and a backtick left in its plain text is exactly an opener the parser could not pair. Returns
 * the offset of the first one, or -1. The caller stops there, so no code is ever read raw.
 */
const openCodeSpan = (root: MdNode, source: string): number => {
  let block: MdNode | undefined = root;
  while (block !== undefined && !TEXT_BLOCKS.has(block.type)) block = block.children?.at(-1);
  if (block === undefined) return -1;
  let first = -1;
  const pending: MdNode[] = [block];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    pending.push(...(node.children ?? []));
    if (node.type !== 'text' || !(node.value ?? '').includes('`')) continue;
    const { start, end } = rangeOf(node);
    const at = source.indexOf('`', start);
    if (at !== -1 && at < end && (first === -1 || at < first)) first = at;
  }
  return first;
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
    const scanned = scanWindow(source);
    let tamed = tame(scanned);
    let root = parse(tamed);
    // A window that ends before the reply does can end inside a code span: stop before it, never read it raw.
    const open = scanned.length < source.length ? openCodeSpan(root, tamed) : -1;
    if (open !== -1) {
      tamed = tamed.slice(0, open);
      root = parse(tamed);
    }
    const all = segmentsOf(blocksOf(root));

    const out: SpeakableSegment[] = [];
    let used = 0;
    let truncated = tamed.length < source.length;
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
