/**
 * LINKS IN A TERMINAL — which text is a link, what it points at, and whether it may be opened.
 *
 * A terminal draws characters, not anchors, so nothing is clickable until something decides it is. That
 * decision is made here, once, for every surface that draws a shell: the live xterm panes (a link
 * provider over the screen buffer, plus xterm's OSC 8 `linkHandler`) and the read-only capture the
 * Console and terminal snapshots show (`findUrlSpans` over plain text). What a tap then DOES is not
 * decided here: the surfaces hand the address to `useLinkBehaviour`, the same "Open links in" decision
 * every chat link uses.
 *
 * ONLY http AND https. `terminalHref` is the one gate, and everything a surface opens passes it:
 * `javascript:`, `data:`, `file:`, `blob:` and anything else a program can print — or an OSC 8
 * sequence can claim — is not a link here, however it is spelled.
 *
 * WRAPPED URLS. A long address printed in a narrow terminal wraps onto several screen rows that the
 * emulator marks as continuations of one logical line. Detection runs over the whole logical line and
 * maps each match back to its cells, so a link is one link however many rows it spans. The structural
 * `LinkableBuffer` is the slice of xterm's buffer this reads, so a test drives it without an emulator.
 *
 * OSC 8 SPOOFING. A program can print `ESC ] 8 ; ; https://evil ESC \ https://bank.example ESC ] 8 ; ;
 * ESC \` — text that says one place and goes to another. `decideHyperlink` therefore opens a hyperlink
 * silently only when what the reader SEES names the same address it points at; every other case asks
 * first, saying both.
 *
 * Coordinates are xterm's: columns and rows 1-based, the end of a range inclusive.
 */

/** How many rows either side of the asked row one logical line is read across. */
const MAX_WRAPPED_ROWS = 32;

/** Punctuation that ends a sentence rather than an address. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '*']);

/** Closers that end an address only when nothing opened them inside it. */
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

const URL_PATTERN = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>"'`\p{Cc}]+/giu;

/** The address a link opens, or null when it is not an http(s) address. */
export const terminalHref = (candidate: string): string | null => {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url.href : null;
};

/** `https://a.test/x).` → `https://a.test/x`: sentence punctuation and unbalanced closers are not the address. */
const trimTrailing = (candidate: string): string => {
  let end = candidate.length;
  for (;;) {
    const last = candidate[end - 1];
    if (last === undefined) return candidate.slice(0, end);
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      const body = candidate.slice(0, end);
      if (count(body, last) > count(body, opener)) {
        end -= 1;
        continue;
      }
    }
    return candidate.slice(0, end);
  }
};

const count = (text: string, char: string): number => {
  let found = 0;
  for (const each of text) if (each === char) found += 1;
  return found;
};

/** One address found in a piece of text: where it is (UTF-16 offsets, end exclusive) and where it goes. */
export interface UrlSpan {
  readonly start: number;
  readonly end: number;
  readonly href: string;
}

export const findUrlSpans = (text: string): readonly UrlSpan[] => {
  const spans: UrlSpan[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const trimmed = trimTrailing(match[0]);
    const href = terminalHref(trimmed);
    if (href === null) continue;
    spans.push({ start: match.index, end: match.index + trimmed.length, href });
  }
  return spans;
};

/** A capture split into the runs the Console draws: plain text, and the addresses inside it. */
export type LinkedRun =
  | { readonly kind: 'text'; readonly at: number; readonly text: string }
  | { readonly kind: 'link'; readonly at: number; readonly text: string; readonly href: string };

/** The runs of `text` in order; `at` is each run's offset in it, which is also a stable key. */
export const splitLinkedRuns = (text: string): readonly LinkedRun[] => {
  const runs: LinkedRun[] = [];
  let cursor = 0;
  for (const span of findUrlSpans(text)) {
    if (span.start > cursor) runs.push({ kind: 'text', at: cursor, text: text.slice(cursor, span.start) });
    runs.push({ kind: 'link', at: span.start, text: text.slice(span.start, span.end), href: span.href });
    cursor = span.end;
  }
  if (cursor < text.length) runs.push({ kind: 'text', at: cursor, text: text.slice(cursor) });
  return runs;
};

/** What xterm's buffer cell answers; the slice detection reads. */
export interface LinkableCell {
  getChars(): string;
  getWidth(): number;
}

/** What xterm's buffer line answers; the slice detection reads. */
export interface LinkableLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): LinkableCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** What xterm's buffer answers; zero-based rows. */
export interface LinkableBuffer {
  getLine(y: number): LinkableLine | undefined;
}

export interface LinkRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/** A link on screen: its range, its text, and the address it opens. */
export interface ScreenLink {
  readonly range: LinkRange;
  readonly text: string;
  readonly href: string;
}

interface CellPosition {
  readonly row: number;
  readonly column: number;
  readonly width: number;
}

/**
 * Every link that touches one screen row, with wrapped continuations followed in both directions.
 *
 * `row` is xterm's 1-based buffer line number. A link that starts on the row above and wraps onto this
 * one is returned from either, with the whole range; xterm shows it as one hover.
 */
export const linksOnRow = (buffer: LinkableBuffer, columns: number, row: number): readonly ScreenLink[] => {
  const asked = row - 1;
  if (buffer.getLine(asked) === undefined) return [];

  let first = asked;
  while (asked - first < MAX_WRAPPED_ROWS && first > 0 && buffer.getLine(first)?.isWrapped === true) first -= 1;
  let last = asked;
  while (last - asked < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped === true) last += 1;

  let text = '';
  const positions: CellPosition[] = [];
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y);
    if (line === undefined) break;
    const width = Math.min(columns, line.length);
    for (let x = 0; x < width; x += 1) {
      const cell = line.getCell(x);
      const cellWidth = cell?.getWidth() ?? 1;
      // The second half of a wide character has no character of its own.
      if (cellWidth === 0) continue;
      const chars = cell?.getChars() || ' ';
      for (let unit = 0; unit < chars.length; unit += 1) positions.push({ row: y, column: x, width: cellWidth });
      text += chars;
    }
  }

  const links: ScreenLink[] = [];
  for (const span of findUrlSpans(text)) {
    const from = positions[span.start];
    const to = positions[span.end - 1];
    if (from === undefined || to === undefined) continue;
    if (asked < from.row || asked > to.row) continue;
    links.push({
      range: {
        start: { x: from.column + 1, y: from.row + 1 },
        end: { x: to.column + to.width, y: to.row + 1 },
      },
      text: text.slice(span.start, span.end),
      href: span.href,
    });
  }
  return links;
};

/** The text a range covers, rows joined without a separator (a wrapped link is one run of characters). */
export const textInRange = (buffer: LinkableBuffer, range: LinkRange): string => {
  let text = '';
  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const line = buffer.getLine(y - 1);
    if (line === undefined) break;
    const from = y === range.start.y ? range.start.x - 1 : 0;
    const to = y === range.end.y ? range.end.x : undefined;
    text += line.translateToString(false, from, to);
  }
  return text;
};

/** What to do with an OSC 8 hyperlink. */
export type HyperlinkDecision =
  /** Not an http(s) address: not a link. */
  | { readonly kind: 'refuse' }
  /** What the reader sees names the address it opens. */
  | { readonly kind: 'open'; readonly href: string }
  /** The text says one thing and the link goes somewhere else: ask first, naming both. */
  | { readonly kind: 'confirm'; readonly href: string; readonly visible: string };

/** The address a piece of visible text names, with or without its scheme, or null when it names none. */
const namedHref = (visible: string): string | null => {
  const text = visible.trim();
  if (text === '' || /\s/u.test(text)) return null;
  return terminalHref(text) ?? (/^[\p{L}\p{N}]/u.test(text) ? terminalHref(`https://${text}`) : null);
};

export const decideHyperlink = (target: string, visibleText: string): HyperlinkDecision => {
  const href = terminalHref(target);
  if (href === null) return { kind: 'refuse' };
  const visible = visibleText.trim();
  return namedHref(visible) === href ? { kind: 'open', href } : { kind: 'confirm', href, visible };
};

const SHOWN_CHARS = 120;

const clip = (text: string): string => (text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text);

/** The question put to the reader before a link whose text does not name its target. */
export const describeHyperlinkMismatch = (visible: string, href: string): string =>
  `This link says “${clip(visible === '' ? '(nothing)' : visible)}” but goes to ${clip(href)}.\n\nOpen it?`;

/** A click as the link opener reads it: a DOM `MouseEvent` is one. */
export interface LinkClick {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

/** What a surface does with an activated link and a link it must ask about. */
export interface TerminalLinkSink {
  open(click: LinkClick, href: string): void;
  confirm(visible: string, href: string): boolean;
}

/** The link provider xterm registers (`Terminal.registerLinkProvider`). */
export interface TerminalLinkProvider {
  provideLinks(
    row: number,
    callback: (
      links:
        | {
            range: LinkRange;
            text: string;
            activate(click: LinkClick, text: string): void;
          }[]
        | undefined,
    ) => void,
  ): void;
}

/** The OSC 8 handler xterm takes as its `linkHandler` option. */
export interface TerminalHyperlinkHandler {
  activate(click: LinkClick, target: string, range: LinkRange): void;
  readonly allowNonHttpProtocols: false;
}

/** The terminal, as the providers read it. Both reads are live: a buffer and a width change under them. */
export interface TerminalScreen {
  buffer(): LinkableBuffer | undefined;
  columns(): number;
}

export const terminalLinkProvider = (screen: TerminalScreen, sink: TerminalLinkSink): TerminalLinkProvider => ({
  provideLinks: (row, callback) => {
    const buffer = screen.buffer();
    const links = buffer === undefined ? [] : linksOnRow(buffer, screen.columns(), row);
    callback(
      links.length === 0
        ? undefined
        : links.map(link => ({
            range: link.range,
            text: link.text,
            activate: click => sink.open(click, link.href),
          })),
    );
  },
});

export const terminalHyperlinkHandler = (screen: TerminalScreen, sink: TerminalLinkSink): TerminalHyperlinkHandler => ({
  allowNonHttpProtocols: false,
  activate: (click, target, range) => {
    const buffer = screen.buffer();
    const decision = decideHyperlink(target, buffer === undefined ? '' : textInRange(buffer, range));
    if (decision.kind === 'refuse') return;
    if (decision.kind === 'confirm' && !sink.confirm(decision.visible, decision.href)) return;
    sink.open(click, decision.href);
  },
});
