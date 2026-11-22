import { parse, postprocess, preprocess } from 'micromark';

/**
 * WHERE EVERY FENCE OF A MESSAGE BEGINS AND ENDS, DECIDED ONCE, BY COMMONMARK.
 *
 * A message is read by two programs that disagree about fences: Durian splits it into parts with its own line scan
 * (any indent, a closer at any indent, no containers), and the reader's browser sees CommonMark (a closer indented four
 * columns is content; a fence lives inside a quote or a list item; a list marker may be followed by a tab). Mirroring
 * CommonMark with a regular expression has failed every time a review found a new spelling, so nothing here mirrors it:
 * the boundaries come from `micromark`'s own tokens, the parser CommonMark's reference tooling is built on.
 *
 * {@link settleFences} turns the message into the text Durian is given. Where Durian's scan and CommonMark's tokens agree
 * about every fence, the text is the message itself. Where they do not, or where a fence has no closing delimiter, the
 * message is read as plain code from the first fence that is in doubt to its end: nothing there draws, however complete
 * a block inside it looks. Pure functions of text; nothing here draws.
 */

/** Durian normalises line endings (`document.ts`) before anything else; line numbers below are the normalised text's. */
export const normalizeText = (source: string): string =>
  source.replace(/\r\n?/gu, '\n').split('\u{0}').join('\u{fffd}');

export const linesOf = (source: string): readonly string[] => normalizeText(source).split('\n');

/** One fenced code block, as CommonMark reads it. Lines are 0-based, in the normalised text. */
export interface CommonMarkFence {
  /** The line of the opening fence. */
  readonly open: number;
  /** The line of the closing fence, or `null`: a fence a container (or the end of the text) ended has no closing delimiter. */
  readonly close: number | null;
  /** The first word of the info string, as written. */
  readonly info: string;
  /** What follows it on the opening line, as written ('' when nothing does). */
  readonly meta: string;
  /** What the fence holds: each line with its container markers and the fence's own indent removed, joined by newlines. */
  readonly body: string;
  /** Nothing but whitespace follows this fence in the text: it is still open at the tail of a message that is arriving. */
  readonly atTail: boolean;
  /** What precedes the fence's delimiter on its opening line: its indent and the markers of the containers it sits in. */
  readonly lead: string;
}

/**
 * What a fence's boundaries do not depend on: the INLINE constructs (emphasis, links, code spans, escapes, references,
 * raw inline HTML) and link reference definitions. Only block structure decides where a fence is, so micromark is told
 * not to look for the rest: a message is read again on every token that streams in, and reading its inline Markdown
 * here, where nothing uses it, would cost most of the time.
 */
const BLOCK_STRUCTURE_ONLY = {
  disable: {
    null: [
      'attention',
      'autolink',
      'characterEscape',
      'characterReference',
      'codeText',
      'definition',
      'hardBreakEscape',
      'htmlText',
      'labelEnd',
      'labelStartImage',
      'labelStartLink',
    ],
  },
};

/** Every fenced code block of `text` (any nesting), in order, read from micromark's token stream. `text` is normalised. */
export function commonMarkFences(text: string): readonly CommonMarkFence[] {
  const events = postprocess(
    parse({ extensions: [BLOCK_STRUCTURE_ONLY] })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const fences: CommonMarkFence[] = [];
  let current: {
    open: number;
    close: number | null;
    info: string;
    meta: string;
    lead: string;
    seen: number;
    values: Map<number, string>;
  } | null = null;
  for (const [step, token] of events) {
    const type: string = token.type;
    if (step === 'enter') {
      if (type === 'codeFenced')
        current = {
          open: token.start.line - 1,
          close: null,
          info: '',
          meta: '',
          lead: text.slice(text.lastIndexOf('\n', token.start.offset - 1) + 1, token.start.offset),
          seen: 0,
          values: new Map(),
        };
      else if (current === null) continue;
      else if (type === 'codeFencedFence') {
        current.seen++;
        if (current.seen === 2) current.close = token.start.line - 1;
      } else if (type === 'codeFencedFenceInfo') current.info = text.slice(token.start.offset, token.end.offset);
      else if (type === 'codeFencedFenceMeta') current.meta = text.slice(token.start.offset, token.end.offset);
      else if (type === 'codeFlowValue')
        current.values.set(token.start.line - 1, text.slice(token.start.offset, token.end.offset));
    } else if (type === 'codeFenced' && current !== null) {
      const last = current.close === null ? Math.max(current.open, ...current.values.keys()) : current.close - 1;
      const body = Array.from({ length: Math.max(0, last - current.open) }, (_, k) =>
        current === null ? '' : (current.values.get(current.open + 1 + k) ?? ''),
      ).join('\n');
      fences.push({
        open: current.open,
        close: current.close,
        info: current.info,
        meta: current.meta,
        body,
        atTail: text.slice(token.end.offset).trim() === '',
        lead: current.lead,
      });
      current = null;
    }
  }
  return fences;
}

/** Durian's own fence pattern (`src/core/dh-lib.ts`): any indent, a run of three or more backticks or tildes, an info string. */
export const DURIAN_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)(.*)$/u;

/** Where Durian ends a fence (its `closeFence`): the next line that, trimmed, is nothing but this fence's own character, at least as long. */
function durianCloser(lines: readonly string[], from: number, fence: string): number {
  for (let j = from + 1; j < lines.length; j++) {
    const trimmed = (lines[j] ?? '').trim();
    if (
      trimmed.startsWith((fence[0] ?? '`').repeat(fence.length)) &&
      /^[`~]+$/u.test(trimmed) &&
      trimmed.length >= fence.length
    )
      return j;
  }
  return -1;
}

/** The fences Durian's line scan finds, which are the ones it splits the message at. A fence it never closes swallows the rest. */
function durianFences(lines: readonly string[]): readonly { readonly open: number; readonly close: number | null }[] {
  const found: { open: number; close: number | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = DURIAN_FENCE.exec(lines[i] ?? '')?.[2];
    if (fence === undefined) continue;
    const close = durianCloser(lines, i, fence);
    found.push({ open: i, close: close < 0 ? null : close });
    if (close < 0) break;
    i = close;
  }
  return found;
}

/** Appended to the opening line of a container fence that has no closing delimiter: a fence with metadata is plain code. */
const HELD_META = 'unclosed';

/** What a message is read as: the text Durian is given, and the table of fences CommonMark made of it. */
export interface SettledFences {
  /** The text Durian parses. */
  readonly text: string;
  /** CommonMark's fences of {@link text}: the one table every later decision reads. */
  readonly fences: readonly CommonMarkFence[];
}

/** Markers of list items and nothing else: what precedes a fence that opens on its list item's own first line. */
const LIST_LEAD = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+$/u;

const visualWidth = (text: string): number => [...text].reduce((w, ch) => (ch === '\t' ? w + 4 - (w % 4) : w + 1), 0);

/**
 * A fence that opens on its list item's own line (` - ```fy-render `) and is closed by a line indented under the item
 * is, to Durian, a closer with no opener: its scan cannot see an opener behind a list marker, so it reads the closing
 * line as an opener that is never closed. The opener is moved to the line below its marker (an item that starts empty
 * and holds the fence is the same item to CommonMark, and the same list to the reader), indented to where it stood, so
 * Durian sees the pair. Only a list marker is moved: a quote marker hides the closer from Durian as well.
 */
function openListFences(lines: readonly string[], fences: readonly CommonMarkFence[]): readonly string[] | null {
  const moved = fences
    .filter(
      fence =>
        fence.close !== null &&
        LIST_LEAD.test(fence.lead) &&
        !DURIAN_FENCE.test(lines[fence.open] ?? '') &&
        DURIAN_FENCE.test(lines[fence.close] ?? ''),
    )
    .sort((a, b) => b.open - a.open);
  if (moved.length === 0) return null;
  const out = [...lines];
  for (const fence of moved) {
    const line = out[fence.open] ?? '';
    out.splice(
      fence.open,
      1,
      fence.lead.trimEnd(),
      `${' '.repeat(visualWidth(fence.lead))}${line.slice(fence.lead.length)}`,
    );
  }
  return out;
}

/** The table row of a held fence: its opening line gained {@link HELD_META}, so that is its info or its meta now. */
const asHeld = (fence: CommonMarkFence): CommonMarkFence =>
  fence.info === ''
    ? { ...fence, info: HELD_META }
    : { ...fence, meta: fence.meta === '' ? HELD_META : `${fence.meta} ${HELD_META}` };

/** Three backticks or tildes in a row: a text without them has no fence, for CommonMark or for Durian. */
const MAY_HOLD_FENCE = /`{3}|~{3}/u;

/** The one word a fence must be opened with to draw anything. A message without it has nothing for CommonMark to decide. */
const FY_RENDER_WORD = 'fy-render';

/**
 * A message that cannot hold a `fy-render` fence draws nothing from one, whatever CommonMark makes of its fences, so its
 * table is empty and it is not read by micromark at all (a long reply is read again on every token that streams in).
 * What Durian itself cannot read is still held: a fence it never closes would make it refuse the whole message, so the
 * message is read as code from that fence on.
 */
function durianOnly(source: string, normal: string): SettledFences {
  const lines = normal.split('\n');
  const unclosed = durianFences(lines).find(found => found.close === null);
  return unclosed === undefined ? { text: source, fences: [] } : { text: inertTail(lines, unclosed.open), fences: [] };
}

/** The lines before `doubt`, then the rest of them as one block of code: a bare fence, longer than any run in them, around them. */
function inertTail(lines: readonly string[], doubt: number): string {
  const bar = longerThanAnyRun(lines.slice(doubt));
  return [...lines.slice(0, doubt), bar, ...lines.slice(doubt), bar].join('\n');
}

/**
 * A run of backticks longer than any run of backticks or tildes in `lines`: a closer of this length cannot be found in
 * them, by Durian or by CommonMark.
 */
const longerThanAnyRun = (lines: readonly string[]): string => {
  const runs = lines.flatMap(line => line.match(/`+|~+/gu) ?? []);
  return '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
};

/**
 * Decides every fence's boundaries once. The message is read as plain code from the first line at which a fence is in
 * doubt, to its end, when
 *  - a fence has no closing delimiter and nothing follows it (a message still arriving: nothing from its opener on draws,
 *    a complete block inside it included, because it is that fence's content), or
 *  - Durian's scan and CommonMark's tokens do not give a fence the same opener and closer (a closer indented four
 *    columns, an opener that is no fence to CommonMark, one Durian never closes).
 * That tail is one bare fence at column 0, longer than any run in it, so Durian and CommonMark both read it as one
 * block of code whatever its lines look like (the text before it keeps its line numbers). A fence in a quote or a list item that its
 * container ended without a closer, with more text after it, is held: its opening line gains a word, so it is code.
 */
export function settleFences(source: string): SettledFences {
  const normal = normalizeText(source);
  if (!MAY_HOLD_FENCE.test(normal)) return { text: source, fences: [] };
  if (!normal.includes(FY_RENDER_WORD)) return durianOnly(source, normal);

  let lines = normal.split('\n');
  let fences = commonMarkFences(normal);
  let edited = false;
  const opened = openListFences(lines, fences);
  if (opened !== null) {
    // The text changed under every later line number: read it again, once.
    lines = [...opened];
    fences = commonMarkFences(lines.join('\n'));
    edited = true;
  }

  let doubt = Number.POSITIVE_INFINITY;
  for (const fence of fences) if (fence.close === null && fence.atTail) doubt = Math.min(doubt, fence.open);
  for (const found of durianFences(lines)) {
    const same = fences.find(fence => fence.open === found.open);
    if (found.close === null || same === undefined || same.close !== found.close) doubt = Math.min(doubt, found.open);
  }

  const held = new Set(fences.filter(fence => fence.close === null && !fence.atTail && fence.open < doubt));
  if (held.size === 0 && doubt === Number.POSITIVE_INFINITY)
    return { text: edited ? lines.join('\n') : source, fences };

  const out = [...lines];
  for (const fence of held) out[fence.open] = `${out[fence.open] ?? ''} ${HELD_META}`;
  // A fence that reaches the tail (its closer is at or after it) is cut by it: it has no row.
  const kept = fences
    .filter(fence => (fence.close ?? fence.open) < doubt)
    .map(fence => (held.has(fence) ? asHeld(fence) : fence));
  if (doubt === Number.POSITIVE_INFINITY) return { text: out.join('\n'), fences: kept };
  // Lines before the tail are unchanged, and CommonMark reads a line without looking ahead, so their rows stand; the
  // tail is one bare fence, which is no `fy-render` and so has no row of interest.
  return { text: inertTail(out, doubt), fences: kept };
}
