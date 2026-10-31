/**
 * A CHAT'S HISTORY, AS PAGES LAID END TO END — the pure half of scrolling up past the newest messages.
 *
 * The chat reads a session's tail on every poll: its newest events, from a byte of the transcript the
 * daemon names (`start`). Scrolling up reads the page `before` the oldest one held, and the page before
 * that, until a page starts at byte `0` and the conversation is whole. Every page begins on a record
 * boundary, so pages that meet at a `start` share no record and miss none, and their text is simply
 * joined.
 *
 * THE TAIL MOVES, AND THAT IS THE ONE HARD PART. Each new record pushes the tail's `start` forward, so
 * the older history held stops where the tail USED to begin (`anchor`). When the tail moves past it,
 * the bytes between are read as a gap and joined onto the held history before the new tail is shown —
 * until then the previous tail stays on screen, so nothing between the two is ever missing.
 *
 * A DIFFERENT FILE STARTS AGAIN. Offsets name places in one file; a tail read from another (the session
 * was re-bound) drops everything older and is the whole history again.
 */

/** One page the daemon served: its text, the byte it begins at, and which file it came from. */
export interface LogPage {
  readonly log: string;
  readonly start: number;
  readonly file: string;
}

export interface TranscriptHistory {
  /** The newest page — the tail that is joined after the older history. */
  readonly tail: LogPage | null;
  /** Older text, oldest first, covering `[olderStart, anchor)`. Empty until the reader scrolls up. */
  readonly older: string;
  /** Where the older history begins: `null` while none is held. */
  readonly olderStart: number | null;
  /** Where the older history ends, which is where the tail it is joined to begins. */
  readonly anchor: number | null;
}

export const EMPTY_HISTORY: TranscriptHistory = { tail: null, older: '', olderStart: null, anchor: null };

/** What the reader can do at the top of the chat. */
export type TranscriptHistoryStatus =
  /** The daemon cannot page (an older one), or nothing has been read yet: no older history is offered. */
  | 'unavailable'
  /** There is older history to load. */
  | 'more'
  | 'loading'
  /** The first message is on screen. */
  | 'start'
  /** The last older page failed; loading again retries it. */
  | 'error';

export const joinLogs = (older: string, newer: string): string =>
  older === '' ? newer : newer === '' ? older : `${older}\n${newer}`;

/** The whole history as one log: what the chat renders. */
export const historyLog = (history: TranscriptHistory): string => joinLogs(history.older, history.tail?.log ?? '');

/** The byte the oldest page held begins at: where the next older page ends. */
export const oldestStart = (history: TranscriptHistory): number | null =>
  history.olderStart ?? history.tail?.start ?? null;

/** What a tail read asks of the history: nothing, or the gap between the held history and the new tail. */
export type TailOutcome =
  | { readonly kind: 'applied'; readonly history: TranscriptHistory }
  | { readonly kind: 'gap'; readonly from: number; readonly before: number; readonly file: string };

/**
 * A freshly read tail, joined to the history held.
 *
 * With no older history, or one that ends exactly where this tail begins, the tail is simply the new
 * end. A tail that has moved past the held history needs the bytes between first (`gap`). A tail of
 * another file — or one that begins BEFORE where the held history ends, which no append can produce —
 * starts the history again.
 */
export const withTail = (history: TranscriptHistory, tail: LogPage): TailOutcome => {
  if (history.olderStart === null || history.anchor === null || history.tail?.file !== tail.file)
    return { kind: 'applied', history: { ...EMPTY_HISTORY, tail } };
  if (tail.start === history.anchor) return { kind: 'applied', history: { ...history, tail } };
  if (tail.start > history.anchor) return { kind: 'gap', from: history.anchor, before: tail.start, file: tail.file };
  return { kind: 'applied', history: { ...EMPTY_HISTORY, tail } };
};

/**
 * The gap between the held history and a tail that moved on, read as `[from, tail.start)` and joined
 * in — or the history started again when the gap could not be read whole (it began past `from`).
 */
export const withGap = (history: TranscriptHistory, gap: LogPage, tail: LogPage): TranscriptHistory => {
  if (history.anchor === null || gap.start !== history.anchor || gap.file !== tail.file)
    return { ...EMPTY_HISTORY, tail };
  return { ...history, older: joinLogs(history.older, gap.log), anchor: tail.start, tail };
};

/**
 * An older page, read `before` the oldest byte held, put in front of the history.
 *
 * `before` is the byte the page was asked for, because the tail may have moved while it was in flight:
 * the history then ends at `before`, and the next tail read fills the gap from there
 * ({@link historyMeetsTail}). A page of another file than the one held, or for a place the history no
 * longer begins at, is not joined at all.
 */
export const withOlder = (history: TranscriptHistory, page: LogPage, before: number): TranscriptHistory => {
  const tail = history.tail;
  if (tail === null || page.file !== tail.file) return history;
  if (history.olderStart === null ? before > tail.start : before !== history.olderStart) return history;
  return {
    ...history,
    older: joinLogs(page.log, history.older),
    olderStart: page.start,
    anchor: history.anchor ?? before,
  };
};

/** Whether the held history and its tail meet, so the tail needs no gap before it is shown in place. */
export const historyMeetsTail = (history: TranscriptHistory): boolean =>
  history.anchor === null || history.tail?.start === history.anchor;
