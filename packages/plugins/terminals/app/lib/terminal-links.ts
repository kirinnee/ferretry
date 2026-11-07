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
 * maps each match back to its cells, so a link is one link however many rows it spans. A program that
 * breaks the address itself (a newline it printed, a tmux repaint) leaves rows the emulator does NOT mark;
 * those are joined too, when the first row runs to the right edge and the next row can only be the rest
 * of the address (`readScreen`, `joins`). The structural
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

/** One drawn cell, as detection reads it: where it is, how wide, and what it shows (a blank is a space). */
interface RowCell {
  readonly column: number;
  readonly width: number;
  readonly chars: string;
}

/** A logical line: the physical rows the emulator itself marked as continuations of one another. */
interface LineSpan {
  readonly first: number;
  readonly last: number;
}

/** The columns of one row that take part in the joined text: `from` inclusive, `to` exclusive. */
interface RowSegment {
  readonly row: number;
  readonly from: number;
  readonly to: number;
}

/**
 * HOW CLOSE TO THE RIGHT EDGE a row's last character must be for the next row to be read as its
 * continuation. A program that breaks a long address itself (Claude Code, codex, gh, anything repainted
 * through tmux) fills the width it believes it has: usually the last cell, sometimes one or two short of
 * it, because it keeps the cell the cursor would wrap on. Wider would join an address that merely ends
 * near the edge to the line below it; the tests on the next row are what guard the rest.
 */
const SPARE_CELLS = 2;

const SCHEME = /https?:\/\//iu;

/** The first token of a continuation row: address characters only, and it begins like an address tail. */
const TAIL_TOKEN = /^[\p{L}\p{N}%/_~.\-?&=#:@+][^\s<>"'`\p{Cc}]*$/u;

/** A bullet or box edge a program draws before its text: `⏺ `, `- `, `│ `. */
const GUTTER = /^\s*[^\p{L}\p{N}\s]\s+/u;

/**
 * The rows around one, read once, and the logical lines a link may span.
 *
 * Two kinds of break are followed. A SOFT wrap is one the emulator made (`isWrapped`): the row below is
 * part of the same line. A HARD break is a newline the program printed, or a tmux repaint (a pane is
 * redrawn with cursor moves, so nothing is marked wrapped): the row below is NOT marked, and is joined
 * only when it can be nothing but the rest of an address — see {@link joins}.
 */
const readScreen = (buffer: LinkableBuffer, columns: number) => {
  const cache = new Map<number, readonly RowCell[]>();
  const cellsOf = (y: number): readonly RowCell[] => {
    const known = cache.get(y);
    if (known !== undefined) return known;
    const line = buffer.getLine(y);
    const cells: RowCell[] = [];
    if (line !== undefined) {
      const width = Math.min(columns, line.length);
      for (let x = 0; x < width; x += 1) {
        const cell = line.getCell(x);
        const cellWidth = cell?.getWidth() ?? 1;
        // The second half of a wide character has no character of its own.
        if (cellWidth === 0) continue;
        cells.push({ column: x, width: cellWidth, chars: cell?.getChars() || ' ' });
      }
    }
    cache.set(y, cells);
    return cells;
  };
  const wrapped = (y: number): boolean => buffer.getLine(y)?.isWrapped === true;
  const textOf = (y: number, from = 0, to = columns): string =>
    cellsOf(y)
      .filter(cell => cell.column >= from && cell.column < to)
      .map(cell => cell.chars)
      .join('');
  const indentOf = (y: number): number => {
    let blanks = 0;
    for (const cell of cellsOf(y)) {
      if (cell.chars !== ' ') break;
      blanks += 1;
    }
    return blanks;
  };
  /** The column after the last character the row shows, or 0 for a blank row. */
  const endOf = (y: number): number => {
    const cells = cellsOf(y);
    for (let at = cells.length - 1; at >= 0; at -= 1) {
      const cell = cells[at];
      if (cell !== undefined && cell.chars.trim() !== '') return cell.column + cell.width;
    }
    return 0;
  };
  const lineAt = (y: number): LineSpan => {
    let first = y;
    while (y - first < MAX_WRAPPED_ROWS && first > 0 && wrapped(first)) first -= 1;
    let last = y;
    while (last - y < MAX_WRAPPED_ROWS && wrapped(last + 1)) last += 1;
    return { first, last };
  };
  const lineText = (span: LineSpan): string => {
    let text = '';
    for (let y = span.first; y <= span.last; y += 1) text += textOf(y, 0, y === span.last ? endOf(y) : columns);
    return text;
  };

  /** Whether the line's last token is, or carries on, an address — through the lines above it. */
  const endsInAddress = (span: LineSpan, depth: number): boolean => {
    const text = lineText(span);
    const token = /\S+$/u.exec(text)?.[0];
    if (token === undefined) return false;
    if (SCHEME.test(token)) return true;
    if (depth >= MAX_WRAPPED_ROWS || text.trimStart() !== token || span.first === 0) return false;
    return joins(lineAt(span.first - 1), span, depth + 1);
  };

  /**
   * Whether `next` carries on the address `previous` ended in, though the emulator did not wrap it.
   *
   * ALL of these hold: `previous` reaches the right edge (a program breaks an address only when it has
   * run out of width); its last token is an address; `next` starts at column 0, or at the indentation
   * `previous` started at, or after the bullet it began with (Claude Code indents a reply two cells);
   * and `next` begins with address characters that are not a bullet, a box edge or a prompt. A bare word
   * followed by more words is a sentence, which also begins a line: it is not joined.
   */
  const joins = (previous: LineSpan, next: LineSpan, depth: number): boolean => {
    if (wrapped(next.first) || endOf(previous.last) < columns - SPARE_CELLS) return false;
    const indent = indentOf(next.first);
    const indents = [0, indentOf(previous.first), GUTTER.exec(textOf(previous.first))?.[0].length ?? 0];
    if (!indents.includes(indent)) return false;
    const rest = textOf(next.first, indent).trimEnd();
    const token = /^\S+/u.exec(rest)?.[0];
    if (token === undefined || !TAIL_TOKEN.test(token) || !/[\p{L}\p{N}]/u.test(token)) return false;
    if (/^\p{L}+$/u.test(token) && rest !== token) return false;
    return endsInAddress(previous, depth);
  };

  /** The segments of every row the logical text around `asked` is read across, in order. */
  const segmentsAround = (asked: number): readonly RowSegment[] => {
    const lines: LineSpan[] = [lineAt(asked)];
    let above = asked - (lines[0]?.first ?? asked);
    for (;;) {
      const top = lines[0];
      if (top === undefined || top.first === 0 || above >= MAX_WRAPPED_ROWS) break;
      const previous = lineAt(top.first - 1);
      if (!joins(previous, top, 0)) break;
      lines.unshift(previous);
      above += previous.last - previous.first + 1;
    }
    let below = (lines[lines.length - 1]?.last ?? asked) - asked;
    for (;;) {
      const bottom = lines[lines.length - 1];
      if (bottom === undefined || below >= MAX_WRAPPED_ROWS || buffer.getLine(bottom.last + 1) === undefined) break;
      const next = lineAt(bottom.last + 1);
      if (!joins(bottom, next, 0)) break;
      lines.push(next);
      below += next.last - next.first + 1;
    }

    const segments: RowSegment[] = [];
    lines.forEach((span, index) => {
      for (let y = span.first; y <= span.last; y += 1) {
        segments.push({
          row: y,
          // A continuation line's indentation is the program's layout, not part of the address.
          from: index > 0 && y === span.first ? indentOf(y) : 0,
          to: index < lines.length - 1 && y === span.last ? endOf(y) : columns,
        });
      }
    });
    return segments;
  };

  return { cellsOf, segmentsAround };
};

/**
 * Every link that touches one screen row, with continuations followed in both directions.
 *
 * `row` is xterm's 1-based buffer line number. A link that starts on the row above and carries on to this
 * one is returned from either, with the whole range; xterm shows it as one hover. A range that crosses a
 * hard break also covers the blanks the program left at the end of the first row and the indentation it
 * put before the second, because a range is contiguous.
 */
export const linksOnRow = (buffer: LinkableBuffer, columns: number, row: number): readonly ScreenLink[] => {
  const asked = row - 1;
  if (buffer.getLine(asked) === undefined) return [];

  const screen = readScreen(buffer, columns);
  let text = '';
  const positions: CellPosition[] = [];
  for (const segment of screen.segmentsAround(asked)) {
    for (const cell of screen.cellsOf(segment.row)) {
      if (cell.column < segment.from || cell.column >= segment.to) continue;
      for (let unit = 0; unit < cell.chars.length; unit += 1)
        positions.push({ row: segment.row, column: cell.column, width: cell.width });
      text += cell.chars;
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
