/**
 * THE AGENDA INBOX, as pure decisions: which conversations read as unread, which cards the inbox
 * deals and in what order, what a swipe means, and how an answer is held back for its undo window.
 *
 * THE UNREAD SIGNAL IS THE DAEMON'S `state.attention`, and nothing else. The daemon rewrites it on every
 * board change and removes it when nothing is open, so a row stays bold until its items are answered,
 * done or dismissed — never merely because the reader looked at the conversation. Reading it off the
 * session list costs no request: the boards themselves are read only for the sessions it names.
 *
 * NEWEST NEEDING YOU FIRST, in both places: a conversation sorts by when its newest open item was
 * raised (`latestAt`), and a card by when its own item was (`waitingSince`).
 *
 * NOTHING HERE MIXES MACHINES. Every entry and card carries the `DaemonId` it was read from, and every
 * key is `(daemonId, sessionId, itemId)`: two machines' `A3` in two same-named sessions are unrelated.
 */

import {
  AGENDA_LINK_PARAMETER,
  type AgendaBrief,
  type AgendaId,
  AgendaIdSchema,
  type AgendaItem,
  type AgendaSnapshot,
  agendaInDiscussion,
  agendaTurn,
  LEGACY_ATTENTION_LINK_PARAMETER,
  type ResolvedAgendaItem,
  type SessionAgendaSummary,
  type SessionView,
} from '@ferretry/protocol';
import { answerActions, type InboxAction, type SwipeDirection, swipeTargets } from './agenda-answers.ts';
import { clockWords } from './agenda-status.ts';
import { sessionAgendaSummary } from './agenda-wire.ts';
import type { DaemonId } from './daemon-connection.ts';
import { BOARD_READ_FAILURE_WORDS, type BoardReadFailure } from './inbox-board-reads.ts';
import { daemonAgendaPath, daemonSessionPath } from './pages/routes.ts';

/** One machine's session list, as the inbox reads it. `sessions` is `null` before the first read. */
export interface AgendaInboxSource {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

/** A conversation with open Attention: the unread row. */
export interface UnreadSession {
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
  readonly attention: SessionAgendaSummary;
}

const instant = (value: string): number => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
};

/**
 * How many of a summary's open items need the OWNER: an item in discussion waits on its ferret, so it is
 * not counted. Every badge, row and tab reads this and never `open` alone.
 */
export const needsYouCount = (summary: Pick<SessionAgendaSummary, 'open' | 'discussing'>): number =>
  Math.max(0, summary.open - (summary.discussing ?? 0));

/**
 * The session's Attention that waits on the owner, or `undefined` when nothing does — including a
 * session whose only open items are in discussion: it reads as read, not as unread.
 */
export const sessionAgenda = (view: SessionView): SessionAgendaSummary | undefined => {
  const summary = sessionAgendaSummary(view.state);
  return summary === undefined || needsYouCount(summary) === 0 ? undefined : summary;
};

/** How many open items a row's badge shows: the ones that need the owner. */
export const unreadCount = (view: SessionView): number => {
  const summary = sessionAgendaSummary(view.state);
  return summary === undefined ? 0 : needsYouCount(summary);
};

/** How many of an open board's items need the owner: the pinned panel's header count. */
export const needsYouItems = (items: readonly Pick<AgendaItem, 'waitingOn' | 'waitingFor' | 'parked'>[]): number =>
  items.filter(item => !agendaInDiscussion(item) && item.parked === undefined).length;

/** The badge's text: a count, capped so it never widens a row. */
export const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));

/** Newest needing you first; equal instants keep machine order, then the session id. */
const byNewestAgenda = (left: UnreadSession, right: UnreadSession): number =>
  instant(right.attention.latestAt) - instant(left.attention.latestAt);

/**
 * Every conversation with open Attention across `sources`, newest needing you first. A machine whose
 * list has not been read contributes nothing — unread, never "nothing waiting".
 */
export const unreadSessions = (sources: readonly AgendaInboxSource[]): readonly UnreadSession[] => {
  const entries: (UnreadSession & { readonly order: number })[] = [];
  sources.forEach((source, order) => {
    for (const view of source.sessions ?? []) {
      const agenda = sessionAgenda(view);
      if (agenda !== undefined)
        entries.push({ daemonId: source.daemonId, machineName: source.name, view, attention: agenda, order });
    }
  });
  entries.sort(
    (left, right) =>
      byNewestAgenda(left, right) ||
      left.order - right.order ||
      left.view.config.id.localeCompare(right.view.config.id),
  );
  return entries.map(({ order: _order, ...entry }) => entry);
};

/** The open items the summaries of `entries` say need the owner: what a conversation counts until its board is read. */
export const unreadTotal = (entries: readonly UnreadSession[]): number =>
  entries.reduce((total, entry) => total + needsYouCount(entry.attention), 0);

/**
 * THE INBOX COUNT: the one number the sidebar's Inbox entry, the top bar, the tab bar and the Inbox page's
 * heading all show. A conversation whose board is held counts what that board puts in the deck — `cards`, plain
 * notifications included and answers still in their undo window left out — and one whose board is not held yet
 * (or could not be read) counts its summary's needs-you items, which are all a device knows of it. Then the cards
 * waiting for a try.
 *
 * The summary and the board disagree on purpose, so the two must never be mixed for one conversation: the
 * summary leaves notifications out and keeps an item waiting on its ferret for more information in, and the deck
 * does the opposite. The badges used to add up summaries while the page counted cards, and read different numbers
 * for the same Inbox.
 */
export const inboxCount = (
  unread: readonly UnreadSession[],
  held: (entry: UnreadSession) => boolean,
  cards: readonly InboxCard[],
  toTest: number,
): number => cards.length + unreadTotal(unread.filter(entry => !held(entry))) + toTest;

/** A machine whose boards could not be read: the items the Inbox counts there but cannot show yet. */
export interface InboxUnavailable {
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly items: number;
  /**
   * Why, as a short clause — "timed out" — or several when its boards failed differently, the one covering the
   * most items first. Absent when no read said why (`unsettled`).
   */
  readonly why?: string;
}

/**
 * The machines with a conversation whose board could not be read, in the order they are listed, with their items
 * and why. `failed` is why an entry's board failed, or `undefined` when it did not.
 */
export const inboxUnavailable = (
  unread: readonly UnreadSession[],
  failed: (entry: UnreadSession) => BoardReadFailure | undefined,
): readonly InboxUnavailable[] => {
  const machines = new Map<DaemonId, InboxUnavailable>();
  const reasons = new Map<DaemonId, Map<string, number>>();
  for (const entry of unread) {
    const failure = failed(entry);
    if (failure === undefined) continue;
    const count = needsYouCount(entry.attention);
    const items = (machines.get(entry.daemonId)?.items ?? 0) + count;
    machines.set(entry.daemonId, { daemonId: entry.daemonId, machineName: entry.machineName, items });
    const words = BOARD_READ_FAILURE_WORDS[failure];
    if (words === undefined) continue;
    const tally = reasons.get(entry.daemonId) ?? new Map<string, number>();
    tally.set(words, (tally.get(words) ?? 0) + count);
    reasons.set(entry.daemonId, tally);
  }
  return [...machines.values()].map(machine => {
    const tally = reasons.get(machine.daemonId);
    if (tally === undefined) return machine;
    const why = [...tally]
      .sort(([, left], [, right]) => right - left)
      .map(([words]) => words)
      .join(', ');
    return { ...machine, why };
  });
};

/**
 * Sorts sessions so the ones with open Attention lead, newest first, and the rest keep their order.
 * Stable, so a list that was already sorted by something else keeps that order below.
 */
export const agendaFirst = <T>(rows: readonly T[], viewOf: (row: T) => SessionView): readonly T[] => {
  const waiting = rows.filter(row => sessionAgenda(viewOf(row)) !== undefined);
  if (waiting.length === 0) return rows;
  const rest = rows.filter(row => sessionAgenda(viewOf(row)) === undefined);
  const latest = (row: T): number => instant(sessionAgenda(viewOf(row))?.latestAt ?? '');
  return [...[...waiting].sort((left, right) => latest(right) - latest(left)), ...rest];
};

/**
 * Every conversation with an open item at all, in the order the sources list them: what the inbox reads
 * boards for, so the items that are with a ferret are on the page (under "With ferrets") and not only counted.
 */
export const withFerretSessions = (sources: readonly AgendaInboxSource[]): readonly UnreadSession[] =>
  sources.flatMap(source =>
    (source.sessions ?? []).flatMap(view => {
      const agenda = sessionAgendaSummary(view.state);
      return agenda === undefined
        ? []
        : [{ daemonId: source.daemonId, machineName: source.name, view, attention: agenda }];
    }),
  );

/**
 * What a board read is keyed on: the summary's facts. When they move the board moved, so the inbox
 * re-reads exactly that session's board; when they hold still it reads nothing. `discussing` is one of
 * them: a discussion starting or ending moves no other fact, and another device must still re-read. So is
 * `stopped`: the ferret going idle on the owner moves its group between sections.
 */
export const agendaSummaryKey = (summary: SessionAgendaSummary): string =>
  `${summary.open}\u0000${summary.first}\u0000${summary.latestAt}\u0000${summary.discussing ?? 0}\u0000${summary.stopped === true ? 1 : 0}`;

/** Where a conversation opens AT an item: the session's page, naming the item (`?agenda=A3`). */
export const agendaConversationPath = (daemonId: DaemonId, sessionId: string, id: AgendaId): string =>
  `${daemonSessionPath(daemonId, sessionId)}?${AGENDA_LINK_PARAMETER}=${encodeURIComponent(id)}`;

/** The item a conversation link names (`?agenda=A3` or the older `?attention=A3`), or `null` for none or a malformed one. */
export const agendaTargetFromSearch = (search: string): AgendaId | null => {
  const params = new URLSearchParams(search);
  const raw = params.get(AGENDA_LINK_PARAMETER) ?? params.get(LEGACY_ATTENTION_LINK_PARAMETER);
  const parsed = AgendaIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** The Inbox query parameter that names the conversation an item belongs to: `/inbox?session=<id>&agenda=A3`. */
const INBOX_SESSION_PARAMETER = 'session';

/** The item an Inbox link opens: the conversation it belongs to, and its id. */
export interface InboxTarget {
  readonly sessionId: string;
  readonly id: AgendaId;
}

/** Where a tap on an Agenda notification lands: the Inbox, asking for this item's card. */
export const inboxTargetPath = (daemonId: DaemonId, sessionId: string, id: AgendaId): string =>
  `${daemonAgendaPath(daemonId)}?${INBOX_SESSION_PARAMETER}=${encodeURIComponent(sessionId)}&${AGENDA_LINK_PARAMETER}=${encodeURIComponent(id)}`;

/** The item an Inbox link names, or `null` when it names none (or a malformed one). */
export const inboxTargetFromSearch = (search: string): InboxTarget | null => {
  const sessionId = new URLSearchParams(search).get(INBOX_SESSION_PARAMETER);
  const id = agendaTargetFromSearch(search);
  return sessionId === null || sessionId.trim() === '' || id === null ? null : { sessionId, id };
};

/** One card in the inbox: an open item, the conversation it belongs to, and the machine that runs it. */
export interface InboxCard {
  /** `(daemonId, sessionId, itemId)`, collision-safe. */
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
  readonly item: AgendaItem;
}

export const inboxCardKey = (daemonId: DaemonId, sessionId: string, id: AgendaId): string =>
  JSON.stringify([daemonId, sessionId, id]);

const collectCards = (
  entries: readonly UnreadSession[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaSnapshot | undefined,
  hidden: ReadonlySet<string>,
  wanted: (item: AgendaItem) => boolean,
): readonly InboxCard[] => {
  const cards: InboxCard[] = [];
  for (const entry of entries) {
    const board = boardFor(entry.daemonId, entry.view.config.id);
    for (const item of board?.items ?? []) {
      const key = inboxCardKey(entry.daemonId, entry.view.config.id, item.id);
      if (wanted(item) && !hidden.has(key))
        cards.push({ key, daemonId: entry.daemonId, machineName: entry.machineName, view: entry.view, item });
    }
  }
  return cards.sort(
    (left, right) =>
      instant(right.item.waitingSince) - instant(left.item.waitingSince) || left.key.localeCompare(right.key),
  );
};

/** An open item that waits on the owner, or a notification (it has no turn: it is read, not answered, and a cleared one is no longer open). */
export const isOnOwner = (item: AgendaItem): boolean => item.notice === true || agendaTurn(item) === 'owner';

/**
 * The deck: every open item on the OWNER's turn (a plain notification included), of every unread
 * conversation whose board has been read, newest first. An item on the ferret's turn is not in it — it
 * comes back as a card when the ferret updates it. `hidden` holds the keys the reader already answered and may still undo — they
 * leave the deck at once.
 */
export const inboxCards = (
  entries: readonly UnreadSession[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaSnapshot | undefined,
  hidden: ReadonlySet<string> = new Set(),
): readonly InboxCard[] => collectCards(entries, boardFor, hidden, isOnOwner);

/** The items on the FERRET's turn, as cards of the same shape and order as the deck's: the "With ferrets" section. */
export const withFerretCards = (
  entries: readonly UnreadSession[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaSnapshot | undefined,
  hidden: ReadonlySet<string> = new Set(),
): readonly InboxCard[] => collectCards(entries, boardFor, hidden, item => agendaTurn(item) === 'ferret');

/**
 * Every PARKED item (snoozed, or replied and waiting on its ferret) of every listed conversation whose board has
 * been read, newest parked first. The daemon's summary leaves parked items out, so a conversation with nothing
 * else open has no unread entry: these are read from the boards themselves, like the resolved records. `hidden`
 * holds the keys of answers still undoable or in flight (an Unsnooze the reader just pressed): they leave at once.
 */
export const inboxParked = (
  sources: readonly AgendaInboxSource[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaSnapshot | undefined,
  hidden: ReadonlySet<string> = new Set(),
): readonly InboxCard[] => {
  const cards: InboxCard[] = [];
  for (const source of sources) {
    for (const view of source.sessions ?? []) {
      for (const item of boardFor(source.daemonId, view.config.id)?.items ?? []) {
        const key = inboxCardKey(source.daemonId, view.config.id, item.id);
        if (item.parked === undefined || hidden.has(key)) continue;
        cards.push({
          key,
          daemonId: source.daemonId,
          machineName: source.name,
          view,
          item,
        });
      }
    }
  }
  return cards.sort(
    (left, right) =>
      instant(right.item.parked?.at ?? '') - instant(left.item.parked?.at ?? '') || left.key.localeCompare(right.key),
  );
};

export type { InboxAction, SwipeDirection };

/** One resolved item in the inbox's Resolved filter: the record, its conversation and its machine. */
export interface InboxResolved {
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
  readonly record: ResolvedAgendaItem;
}

/**
 * The resolved records of every listed conversation whose board has been read, newest resolution first.
 * A conversation whose board has not been read contributes nothing, never "nothing resolved".
 */
export const inboxResolved = (
  sources: readonly AgendaInboxSource[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaSnapshot | undefined,
): readonly InboxResolved[] => {
  const rows: InboxResolved[] = [];
  for (const source of sources) {
    for (const view of source.sessions ?? []) {
      for (const record of boardFor(source.daemonId, view.config.id)?.resolved ?? []) {
        rows.push({
          key: inboxCardKey(source.daemonId, view.config.id, record.id),
          daemonId: source.daemonId,
          machineName: source.name,
          view,
          record,
        });
      }
    }
  }
  return rows.sort(
    (left, right) =>
      instant(right.record.resolvedAt) - instant(left.record.resolvedAt) || left.key.localeCompare(right.key),
  );
};

/** How many conversations the Resolved filter reads boards for: history is not worth a request per session. */
export const RESOLVED_READ_LIMIT = 30;

/**
 * The conversations the Resolved filter should read: the most recently active ones whose board is not
 * held yet, at most {@link RESOLVED_READ_LIMIT} counting those already held, across every machine.
 */
export const sessionsToReadForResolved = (
  sources: readonly AgendaInboxSource[],
  hasBoard: (daemonId: DaemonId, sessionId: string) => boolean,
): readonly { readonly daemonId: DaemonId; readonly sessionId: string }[] => {
  const recent = sources
    .flatMap(source => (source.sessions ?? []).map(view => ({ daemonId: source.daemonId, view })))
    .sort(
      (left, right) => instant(right.view.state.lastActivityAt ?? '') - instant(left.view.state.lastActivityAt ?? ''),
    )
    .slice(0, RESOLVED_READ_LIMIT);
  return recent
    .filter(entry => !hasBoard(entry.daemonId, entry.view.config.id))
    .map(entry => ({ daemonId: entry.daemonId, sessionId: entry.view.config.id }));
};

/** Park an item until `until` (an instant): it leaves the list and comes back by itself. */
export const snoozeAction = (until: string): InboxAction => ({ kind: 'snooze', label: 'Snooze', until });

/** Put a snoozed or replied item back on the owner's list now. */
export const UNSNOOZE_ACTION: InboxAction = { kind: 'unsnooze', label: 'Back to my list' };

export const DONE_ACTION: InboxAction = { kind: 'resolve', label: 'Done' };
export const DISMISS_ACTION: InboxAction = { kind: 'dismiss', label: 'Dismiss' };
export const NEEDS_INFO_ACTION: Extract<InboxAction, { kind: 'needs-info' }> = {
  kind: 'needs-info',
  label: 'Need more info',
};

/** The ticked steps of an item once the not-yet-confirmed ticks are laid over them. */
export const tickedSteps = (
  item: Pick<AgendaItem, 'steps' | 'stepsDone'>,
  pending: ReadonlyMap<number, boolean> = new Map(),
): ReadonlySet<number> => {
  const ticked = new Set(item.stepsDone ?? []);
  for (const [step, done] of pending) {
    if (done) ticked.add(step);
    else ticked.delete(step);
  }
  return ticked;
};

const clock = (instantValue: string, timeZone?: string): string =>
  new Date(instantValue).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });

/**
 * What happened to a to-do since the owner first looked, in the owner's local time:
 * "You asked for more info 10:42 · updated 10:44". `null` when nothing has.
 */
export const historyLine = (history: AgendaItem['history'], timeZone?: string): string | null => {
  if (history === undefined || history.length === 0) return null;
  const words = history.map(entry =>
    entry.kind === 'needs-info'
      ? `You asked for more info ${clock(entry.at, timeZone)}`
      : entry.kind === 'discuss'
        ? `You asked to discuss ${clock(entry.at, timeZone)}`
        : `updated ${clock(entry.at, timeZone)}`,
  );
  return words.join(' · ');
};

/** The ferret edited this item after being asked: it needs the owner again, and says what changed. */
export const updatedSinceAsked = (
  item: Pick<AgendaItem, 'history' | 'waitingOn'>,
): { readonly at: string; readonly note?: string } | null => {
  const last = item.history?.at(-1);
  if (item.waitingOn !== undefined || last === undefined || last.kind !== 'updated') return null;
  return { at: last.at, ...(last.note === undefined ? {} : { note: last.note }) };
};

/**
 * The item's answers as actions, the recommended one first: the card's right, up and left answers, then
 * an old choice's options past the third (buttons only). The answers are the card's own
 * (`agendaCardAnswers`); see `agenda-answers.ts`.
 */
export const inboxOptions = (item: Parameters<typeof answerActions>[0]): readonly InboxAction[] => answerActions(item);

/** Whether an item carries any of the structured brief; an old item carries none. */
export const hasAgendaBrief = (item: AgendaBrief): boolean =>
  item.premise !== undefined ||
  item.decided !== undefined ||
  item.terms !== undefined ||
  item.questions !== undefined ||
  item.recommendation !== undefined ||
  item.impact !== undefined ||
  item.urgency !== undefined ||
  item.links !== undefined;

/**
 * The item's `why`, or `null` when it only repeats the summary. The CLI used to fill `why` with the
 * subject, which drew the same sentence twice; a card never draws it twice.
 */
export const visibleWhy = (item: Pick<AgendaItem, 'subject' | 'why'>): string | null => {
  const why = item.why.trim();
  return why === '' || why === item.subject.trim() ? null : why;
};

export type SwipeMap = Readonly<Partial<Record<SwipeDirection, InboxAction>>>;

/**
 * What each swipe does to a card: the card's own answers by direction, carrying `reply` as their note.
 * A direction with no answer is absent and never commits; a review's "Needs changes" is absent until
 * the reply has text, because it IS that text (`swipeTargets` keeps it, for the stamp and the box).
 */
export const swipeMap = (item: Parameters<typeof swipeTargets>[0], reply = ''): SwipeMap =>
  Object.fromEntries(
    Object.entries(swipeTargets(item, reply)).flatMap(([direction, target]) =>
      target.action === null ? [] : [[direction, target.action]],
    ),
  );

/**
 * Which swipe, if any, an answer sits on — matched by meaning, because `inboxOptions` builds its
 * answers afresh on every call: the button and the gesture must agree on the SAME option.
 */
export const directionOfAction = (map: SwipeMap, action: InboxAction): SwipeDirection | null => {
  for (const direction of ['right', 'left', 'up'] as const) {
    const mapped = map[direction];
    if (mapped !== undefined && mapped.kind === action.kind && mapped.label === action.label) return direction;
  }
  return null;
};

/** A drag must travel this far before it moves at all, so a scroll is never read as a swipe. */
export const SWIPE_SLOP_PX = 10;
const SWIPE_MINIMUM_PX = 96;
const SWIPE_MAXIMUM_PX = 160;

/** How far a card must travel to commit, for a card this wide: a clear distance, never a flick. */
export const swipeThreshold = (width: number): number =>
  Math.min(SWIPE_MAXIMUM_PX, Math.max(SWIPE_MINIMUM_PX, width * 0.35));

export interface SwipeIntent {
  /** The direction the drag is reading as, or `null` while it is too small. */
  readonly direction: SwipeDirection | null;
  /** 0 → 1 as the drag approaches the threshold; 1 at and beyond it. */
  readonly progress: number;
  /** True only past the threshold, and only toward a direction that has an action. */
  readonly committed: boolean;
}

/**
 * Reads a drag of `(dx, dy)` on a card `width` wide. The dominant axis wins; a drag down is no
 * answer (the deck hands the browser every drag it must not read: see `agenda-swipe-deck.tsx`). A
 * direction with no action never commits.
 */
export const swipeIntent = (
  dx: number,
  dy: number,
  width: number,
  map: Readonly<Partial<Record<SwipeDirection, unknown>>>,
): SwipeIntent => {
  const threshold = swipeThreshold(width);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
  if (distance < SWIPE_SLOP_PX) return { direction: null, progress: 0, committed: false };
  const direction: SwipeDirection | null = horizontal ? (dx > 0 ? 'right' : 'left') : dy < 0 ? 'up' : null;
  const progress = Math.min(1, distance / threshold);
  return { direction, progress, committed: direction !== null && progress >= 1 && map[direction] !== undefined };
};

/** The words an undo toast uses for an action it is holding. */
export const actionSentence = (action: InboxAction, id: AgendaId, now = Date.now()): string => {
  if (action.kind === 'snooze') return `Snoozed !${id} until ${clockWords(action.until, now) ?? 'later'}`;
  if (action.kind === 'unsnooze') return `!${id} is back on your list`;
  if (action.kind === 'dismiss') return `Dismissed !${id}`;
  if (action.kind === 'needs-info') return `Asked for more info on !${id}`;
  if (action.kind === 'discuss') return `Asked to discuss !${id}`;
  if (action.label === 'Reply') return `Replied to !${id}`;
  if (action.kind === 'resolve' && action.label === 'Clear') return `Cleared !${id}`;
  if (action.kind === 'resolve') return `Marked !${id} done`;
  return `Answered !${id}: ${action.label}`;
};

/** How long an answer waits, undoable, before it is sent. */
export const UNDO_WINDOW_MS = 5_000;

/** An answer the reader gave and may still take back. */
export interface PendingAgendaAction {
  readonly key: string;
  readonly card: InboxCard;
  readonly action: InboxAction;
  readonly deadline: number;
}

/** An answer the daemon refused, kept so the card can come back with the reason. */
export interface FailedAgendaAction {
  readonly key: string;
  readonly card: InboxCard;
  readonly action: InboxAction;
  readonly message: string;
}

export interface DeferredAgendaState {
  readonly pending: readonly PendingAgendaAction[];
  /** Keys whose answer is on its way to the daemon now: past undo, not yet settled. */
  readonly sending: readonly string[];
  readonly failed: readonly FailedAgendaAction[];
}

/** The clock seams, injectable so the undo window is testable without waiting it out. */
export interface DeferredTimers {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export const browserDeferredTimers: DeferredTimers = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};

type Commit = (card: InboxCard, action: InboxAction) => Promise<void>;

/**
 * Answers held for their undo window, then sent. NOTHING IS POSTED BEFORE THE WINDOW CLOSES: undo is
 * a real undo, not a second request that hopes to cancel the first. `flush` sends everything held at
 * once — what leaving the page does, because an answer the reader gave is not lost by navigating.
 */
export class DeferredAgendaActions {
  #state: DeferredAgendaState = { pending: [], sending: [], failed: [] };
  readonly #timers = new Map<string, unknown>();
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly commit: Commit,
    private readonly timers: DeferredTimers = browserDeferredTimers,
    private readonly windowMs: number = UNDO_WINDOW_MS,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): DeferredAgendaState => this.#state;

  /** Keys that should not be on the deck: held, being sent. A failed one comes back. */
  hiddenKeys(): ReadonlySet<string> {
    return new Set([...this.#state.pending.map(entry => entry.key), ...this.#state.sending]);
  }

  /** Holds `action` for `card`. Answering the same card again replaces what was held. */
  schedule(card: InboxCard, action: InboxAction): void {
    this.#cancelTimer(card.key);
    const entry: PendingAgendaAction = {
      key: card.key,
      card,
      action,
      deadline: this.timers.now() + this.windowMs,
    };
    this.#timers.set(
      card.key,
      this.timers.setTimeout(() => this.#send(card.key), this.windowMs),
    );
    this.#publish({
      ...this.#state,
      pending: [...this.#state.pending.filter(pending => pending.key !== card.key), entry],
      failed: this.#state.failed.filter(failed => failed.key !== card.key),
    });
  }

  /** Takes back the named answer, or the most recent one. Returns what was undone, if anything. */
  undo(key?: string): PendingAgendaAction | null {
    const target = key === undefined ? this.#state.pending.at(-1) : this.#state.pending.find(p => p.key === key);
    if (target === undefined) return null;
    this.#cancelTimer(target.key);
    this.#publish({ ...this.#state, pending: this.#state.pending.filter(pending => pending.key !== target.key) });
    return target;
  }

  /** Forgets a refusal once the reader has seen it. */
  clearFailure(key: string): void {
    this.#publish({ ...this.#state, failed: this.#state.failed.filter(failed => failed.key !== key) });
  }

  /** Sends everything still held, now. */
  flush(): void {
    for (const pending of [...this.#state.pending]) this.#send(pending.key);
  }

  #send(key: string): void {
    const entry = this.#state.pending.find(pending => pending.key === key);
    this.#cancelTimer(key);
    if (entry === undefined) return;
    this.#publish({
      ...this.#state,
      pending: this.#state.pending.filter(pending => pending.key !== key),
      sending: [...this.#state.sending, key],
    });
    void this.commit(entry.card, entry.action).then(
      () => this.#settle(key, null),
      (reason: unknown) =>
        this.#settle(key, {
          key,
          card: entry.card,
          action: entry.action,
          message: reason instanceof Error ? reason.message : 'The machine did not accept this answer.',
        }),
    );
  }

  #settle(key: string, failure: FailedAgendaAction | null): void {
    this.#publish({
      ...this.#state,
      sending: this.#state.sending.filter(sending => sending !== key),
      failed: failure === null ? this.#state.failed : [...this.#state.failed.filter(f => f.key !== key), failure],
    });
  }

  #cancelTimer(key: string): void {
    const handle = this.#timers.get(key);
    if (handle !== undefined) this.timers.clearTimeout(handle);
    this.#timers.delete(key);
  }

  #publish(state: DeferredAgendaState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

/** The card a link names: `#agenda/A3?session=<id>`. The session is optional only because an id alone is per-session. */
export interface AgendaDeepLink {
  readonly id: AgendaId;
  readonly sessionId?: string;
}

/** The card a location hash names, or `null` for any other hash (the join fragment among them). */
export const agendaDeepLinkFromHash = (hash: string): AgendaDeepLink | null => {
  const match = /^#agenda\/([^?]+)(?:\?(.*))?$/u.exec(hash);
  if (match === null) return null;
  const raw = ((): string => {
    try {
      return decodeURIComponent(match[1] ?? '');
    } catch {
      return '';
    }
  })();
  const id = AgendaIdSchema.safeParse(raw);
  if (!id.success) return null;
  const session = new URLSearchParams(match[2] ?? '').get(INBOX_SESSION_PARAMETER);
  return session === null || session.trim() === '' ? { id: id.data } : { id: id.data, sessionId: session };
};

/**
 * Which paired machine runs the linked session: the one whose session list holds it. `'wait'` while a machine that might
 * hold it has not been read yet; `undefined` when no machine does (or the link names no session).
 */
export const machineForAgendaLink = (
  link: AgendaDeepLink,
  machines: readonly { readonly daemonId: DaemonId; readonly sessionIds: readonly string[] | null }[],
): DaemonId | 'wait' | undefined => {
  if (link.sessionId === undefined) return undefined;
  const held = machines.find(machine => machine.sessionIds?.includes(link.sessionId ?? '') === true);
  if (held !== undefined) return held.daemonId;
  return machines.some(machine => machine.sessionIds === null) ? 'wait' : undefined;
};
