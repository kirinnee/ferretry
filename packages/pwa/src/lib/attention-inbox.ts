/**
 * THE ATTENTION INBOX, as pure decisions: which conversations read as unread, which cards the inbox
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
  ATTENTION_LINK_PARAMETER,
  type AttentionBrief,
  type AttentionId,
  AttentionIdSchema,
  type AttentionItem,
  type AttentionQuestion,
  type AttentionResponse,
  type AttentionSnapshot,
  MAX_ATTENTION_DETAIL_LENGTH,
  type SessionAttentionSummary,
  type SessionView,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { daemonSessionPath } from './pages/routes.ts';

/** One machine's session list, as the inbox reads it. `sessions` is `null` before the first read. */
export interface AttentionInboxSource {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

/** A conversation with open Attention: the unread row. */
export interface UnreadSession {
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
  readonly attention: SessionAttentionSummary;
}

const instant = (value: string): number => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
};

/** The session's open Attention, or `undefined` when nothing waits on the owner. */
export const sessionAttention = (view: SessionView): SessionAttentionSummary | undefined => view.state.attention;

/** How many open items a row's badge shows. */
export const unreadCount = (view: SessionView): number => view.state.attention?.open ?? 0;

/** The badge's text: a count, capped so it never widens a row. */
export const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));

/** Newest needing you first; equal instants keep machine order, then the session id. */
const byNewestAttention = (left: UnreadSession, right: UnreadSession): number =>
  instant(right.attention.latestAt) - instant(left.attention.latestAt);

/**
 * Every conversation with open Attention across `sources`, newest needing you first. A machine whose
 * list has not been read contributes nothing — unread, never "nothing waiting".
 */
export const unreadSessions = (sources: readonly AttentionInboxSource[]): readonly UnreadSession[] => {
  const entries: (UnreadSession & { readonly order: number })[] = [];
  sources.forEach((source, order) => {
    for (const view of source.sessions ?? []) {
      const attention = sessionAttention(view);
      if (attention !== undefined)
        entries.push({ daemonId: source.daemonId, machineName: source.name, view, attention, order });
    }
  });
  entries.sort(
    (left, right) =>
      byNewestAttention(left, right) ||
      left.order - right.order ||
      left.view.config.id.localeCompare(right.view.config.id),
  );
  return entries.map(({ order: _order, ...entry }) => entry);
};

/** The open items across every listed conversation: the number on the Attention tab. */
export const unreadTotal = (entries: readonly UnreadSession[]): number =>
  entries.reduce((total, entry) => total + entry.attention.open, 0);

/**
 * Sorts sessions so the ones with open Attention lead, newest first, and the rest keep their order.
 * Stable, so a list that was already sorted by something else keeps that order below.
 */
export const attentionFirst = <T>(rows: readonly T[], viewOf: (row: T) => SessionView): readonly T[] => {
  const waiting = rows.filter(row => sessionAttention(viewOf(row)) !== undefined);
  if (waiting.length === 0) return rows;
  const rest = rows.filter(row => sessionAttention(viewOf(row)) === undefined);
  const latest = (row: T): number => instant(sessionAttention(viewOf(row))?.latestAt ?? '');
  return [...[...waiting].sort((left, right) => latest(right) - latest(left)), ...rest];
};

/**
 * What a board read is keyed on: the summary's facts. When they move the board moved, so the inbox
 * re-reads exactly that session's board; when they hold still it reads nothing.
 */
export const attentionSummaryKey = (summary: SessionAttentionSummary): string =>
  `${summary.open}\u0000${summary.first}\u0000${summary.latestAt}`;

/** Where a conversation opens AT an item: the session's page, naming the item as the protocol says. */
export const attentionConversationPath = (daemonId: DaemonId, sessionId: string, id: AttentionId): string =>
  `${daemonSessionPath(daemonId, sessionId)}?${ATTENTION_LINK_PARAMETER}=${encodeURIComponent(id)}`;

/** The item a conversation link names (`?attention=A3`), or `null` for none or a malformed one. */
export const attentionTargetFromSearch = (search: string): AttentionId | null => {
  const raw = new URLSearchParams(search).get(ATTENTION_LINK_PARAMETER);
  const parsed = AttentionIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** One card in the inbox: an open item, the conversation it belongs to, and the machine that runs it. */
export interface InboxCard {
  /** `(daemonId, sessionId, itemId)`, collision-safe. */
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
  readonly item: AttentionItem;
}

export const inboxCardKey = (daemonId: DaemonId, sessionId: string, id: AttentionId): string =>
  JSON.stringify([daemonId, sessionId, id]);

/**
 * The deck: every open item of every unread conversation whose board has been read, newest first.
 * `hidden` holds the keys the reader already answered and may still undo — they leave the deck at once.
 */
export const inboxCards = (
  entries: readonly UnreadSession[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AttentionSnapshot | undefined,
  hidden: ReadonlySet<string> = new Set(),
): readonly InboxCard[] => {
  const cards: InboxCard[] = [];
  for (const entry of entries) {
    const board = boardFor(entry.daemonId, entry.view.config.id);
    for (const item of board?.items ?? []) {
      const key = inboxCardKey(entry.daemonId, entry.view.config.id, item.id);
      if (!hidden.has(key))
        cards.push({ key, daemonId: entry.daemonId, machineName: entry.machineName, view: entry.view, item });
    }
  }
  return cards.sort(
    (left, right) =>
      instant(right.item.waitingSince) - instant(left.item.waitingSince) || left.key.localeCompare(right.key),
  );
};

/** What answering a card does, as the daemon is asked to do it. */
export type InboxAction =
  | { readonly kind: 'respond'; readonly label: string; readonly response: AttentionResponse }
  | { readonly kind: 'resolve'; readonly label: string; readonly note?: string }
  | { readonly kind: 'dismiss'; readonly label: string; readonly note?: string };

export const DONE_ACTION: InboxAction = { kind: 'resolve', label: 'Done' };
export const DISMISS_ACTION: InboxAction = { kind: 'dismiss', label: 'Dismiss' };

/**
 * The item's answers in the order a swipe takes them: an affirmative answer first (Approve, "The answer
 * is good"), then the options as the agent listed them, then a negative one (Reject).
 */
export const inboxOptions = (item: Pick<AttentionItem, 'ask'>): readonly InboxAction[] => {
  const ask = item.ask;
  if (ask === undefined) return [];
  switch (ask.kind) {
    case 'permission':
      return [
        { kind: 'respond', label: 'Approve', response: { kind: 'permission', decision: 'approve' } },
        { kind: 'respond', label: 'Reject', response: { kind: 'permission', decision: 'reject' } },
      ];
    case 'multiple-choice':
      return ask.options.map(option => ({
        kind: 'respond' as const,
        label: option.label,
        response: { kind: 'multiple-choice' as const, choice: option.label },
      }));
    case 'answer-review':
      return [{ kind: 'respond', label: 'Looks good', response: { kind: 'answer-review', verdict: 'good' } }];
    case 'open-question':
      return [];
  }
};

/** Whether an item carries any of the structured brief; an old item carries none. */
export const hasAttentionBrief = (item: AttentionBrief): boolean =>
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
export const visibleWhy = (item: Pick<AttentionItem, 'subject' | 'why'>): string | null => {
  const why = item.why.trim();
  return why === '' || why === item.subject.trim() ? null : why;
};

/** The item asks several things, so it is answered one answer per question. */
export const hasSeveralQuestions = (item: AttentionBrief): boolean => (item.questions?.length ?? 0) > 1;

/** Several questions AND the open-question ask that takes their answers as one reply. */
export const answersPerQuestion = (item: AttentionBrief & Pick<AttentionItem, 'ask'>): boolean =>
  hasSeveralQuestions(item) && item.ask?.kind === 'open-question';

const NO_ANSWER = '(no answer)';
const MIN_QUESTION_CHARACTERS = 24;

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;

/**
 * One open-question reply from per-question answers: `1. <question>\n→ <answer>`, blank line between,
 * `→ (no answer)` for an unanswered one. It must fit `MAX_ATTENTION_DETAIL_LENGTH`: questions are cut
 * to make room, answers never are — and `null` (refuse) when the answers alone do not fit.
 */
export const composeQuestionAnswers = (
  questions: readonly Pick<AttentionQuestion, 'question'>[],
  answers: readonly (string | undefined)[],
): string | null => {
  const answerOf = (index: number): string => {
    const answer = answers[index]?.trim() ?? '';
    return answer === '' ? NO_ANSWER : answer;
  };
  const build = (limit: number): string =>
    questions
      .map(
        (entry, index) =>
          `${index + 1}. ${clip(entry.question.trim().replace(/\s+/gu, ' '), limit)}\n→ ${answerOf(index)}`,
      )
      .join('\n\n');
  let limit = Number.POSITIVE_INFINITY;
  let text = build(limit);
  if (text.length > MAX_ATTENTION_DETAIL_LENGTH) {
    limit = Math.max(...questions.map(entry => entry.question.length));
    while (text.length > MAX_ATTENTION_DETAIL_LENGTH && limit > MIN_QUESTION_CHARACTERS) {
      limit = Math.max(MIN_QUESTION_CHARACTERS, Math.floor(limit * 0.8));
      text = build(limit);
    }
  }
  return text.length > MAX_ATTENTION_DETAIL_LENGTH || answers.every(answer => (answer?.trim() ?? '') === '')
    ? null
    : text;
};

/** The one reply a several-question item sends, as an action — or `null` when it cannot be sent. */
export const questionAnswersAction = (
  questions: readonly Pick<AttentionQuestion, 'question'>[],
  answers: readonly (string | undefined)[],
): InboxAction | null => {
  const answer = composeQuestionAnswers(questions, answers);
  return answer === null ? null : { kind: 'respond', label: 'Reply', response: { kind: 'open-question', answer } };
};

export type SwipeDirection = 'right' | 'left' | 'up';

export type SwipeMap = Readonly<Partial<Record<SwipeDirection, InboxAction>>>;

/**
 * What each swipe does to a card: right is Done, left is Dismiss. A swipe never picks between a
 * card's options — those are buttons — and `up` stays free for a later gesture.
 */
export const swipeMap = (_item: Pick<AttentionItem, 'ask' | 'questions'>): SwipeMap => ({
  right: DONE_ACTION,
  left: DISMISS_ACTION,
});

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
  /** The direction the drag is reading as, or `null` while it is too small or points down. */
  readonly direction: SwipeDirection | null;
  /** 0 → 1 as the drag approaches the threshold; 1 at and beyond it. */
  readonly progress: number;
  /** True only past the threshold, and only toward a direction that has an action. */
  readonly committed: boolean;
}

/**
 * Reads a drag of `(dx, dy)` on a card `width` wide. The dominant axis wins; a drag down means nothing,
 * because the deck scrolls that way. A direction with no action never commits.
 */
export const swipeIntent = (dx: number, dy: number, width: number, map: SwipeMap): SwipeIntent => {
  const threshold = swipeThreshold(width);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const distance = horizontal ? Math.abs(dx) : -dy;
  if (distance < SWIPE_SLOP_PX) return { direction: null, progress: 0, committed: false };
  const direction: SwipeDirection = horizontal ? (dx > 0 ? 'right' : 'left') : 'up';
  const progress = Math.min(1, distance / threshold);
  return { direction, progress, committed: progress >= 1 && map[direction] !== undefined };
};

/**
 * A reply typed on a card, as the daemon accepts it: an open question takes it as THE answer, a review
 * as the clarification asked for, and every other kind as the note a Done carries — which the daemon
 * hands the ferret as "[answer to !A3 «ask»] <note>". Blank text is no reply.
 */
export const replyAction = (item: Pick<AttentionItem, 'ask'>, text: string): InboxAction | null => {
  const answer = text.trim();
  if (answer === '') return null;
  if (item.ask?.kind === 'open-question')
    return { kind: 'respond', label: 'Reply', response: { kind: 'open-question', answer } };
  if (item.ask?.kind === 'answer-review')
    return {
      kind: 'respond',
      label: 'Reply',
      response: { kind: 'answer-review', verdict: 'clarify', clarification: answer },
    };
  return { kind: 'resolve', label: 'Reply', note: answer };
};

/** The words an undo toast uses for an action it is holding. */
export const actionSentence = (action: InboxAction, id: AttentionId): string => {
  if (action.kind === 'dismiss') return `Dismissed !${id}`;
  if (action.label === 'Reply') return `Replied to !${id}`;
  if (action.kind === 'resolve') return `Marked !${id} done`;
  return `Answered !${id}: ${action.label}`;
};

/** How long an answer waits, undoable, before it is sent. */
export const UNDO_WINDOW_MS = 5_000;

/** An answer the reader gave and may still take back. */
export interface PendingAttentionAction {
  readonly key: string;
  readonly card: InboxCard;
  readonly action: InboxAction;
  readonly deadline: number;
}

/** An answer the daemon refused, kept so the card can come back with the reason. */
export interface FailedAttentionAction {
  readonly key: string;
  readonly card: InboxCard;
  readonly action: InboxAction;
  readonly message: string;
}

export interface DeferredAttentionState {
  readonly pending: readonly PendingAttentionAction[];
  /** Keys whose answer is on its way to the daemon now: past undo, not yet settled. */
  readonly sending: readonly string[];
  readonly failed: readonly FailedAttentionAction[];
}

/** The clock seams, injectable so the undo window is testable without waiting it out. */
export interface DeferredTimers {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

const browserDeferredTimers: DeferredTimers = {
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
export class DeferredAttentionActions {
  #state: DeferredAttentionState = { pending: [], sending: [], failed: [] };
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

  getSnapshot = (): DeferredAttentionState => this.#state;

  /** Keys that should not be on the deck: held, being sent. A failed one comes back. */
  hiddenKeys(): ReadonlySet<string> {
    return new Set([...this.#state.pending.map(entry => entry.key), ...this.#state.sending]);
  }

  /** Holds `action` for `card`. Answering the same card again replaces what was held. */
  schedule(card: InboxCard, action: InboxAction): void {
    this.#cancelTimer(card.key);
    const entry: PendingAttentionAction = {
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
  undo(key?: string): PendingAttentionAction | null {
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

  #settle(key: string, failure: FailedAttentionAction | null): void {
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

  #publish(state: DeferredAttentionState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
