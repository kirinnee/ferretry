/**
 * THE ITEM VIEW'S EIGHT PARTS, as pure decisions (docs/agenda.md § The item view). One item view everywhere — the chat,
 * the Inbox, the side panel — reads top to bottom. The body is the item's LIVE DOCUMENT (the owner: "the chat is the
 * stream of log, the body is the DB"), so the four parts that say what this is and what it needs come first, the body
 * after them, and the log — the conversation and the activity — at the bottom:
 *
 *   1 head          the one-line title, the STATE chip and the STAGE chip (small, on the line under it), then the
 *                   description (the item's summary); the quiet controls are the head's ⋯ menu
 *   2 premise       premise and context: may be long, and may assume what the owner already knows
 *   3 detail        the context explained from zero (`detail`): FOLDED by default
 *   4 references    one TABLE of every term and every PR, card or link, each with a plain meaning: FOLDED
 *   5 needs         what it needs from the owner: the ask with its buttons, and every card ask with ITS buttons
 *   6 tabs          the live document as tabs (&F923): "Where we are now" first and open (the answer to the owner's
 *                   question, what is decided, what is open, then the ferret's own Markdown), "The full picture", then
 *                   the ferret's own tabs — every one Markdown with fy-render
 *   7 conversation  the owner's and the ferret's words, oldest first: the log, never a second copy of a tab: FOLDED
 *   8 activity      the grey "updated / moved / snoozed" lines: FOLDED, kept apart from the conversation
 *
 * Nothing here draws anything, and nothing here cuts text short: every line is kept whole.
 */

import {
  type AgendaCardAsk,
  type AgendaGate,
  type AgendaHistoryEntry,
  type AgendaItem,
  type AgendaStage,
  agendaStage,
  askedCardAsks,
  agendaState,
  gateReference,
  gateTypedLabel,
  itemAsksOwnQuestion,
  nothingToTryLine,
  openCardAsks,
  parseGateReference,
} from '@ferretry/protocol';
import { type SwipeTargets, swipeTargets } from './agenda-answers.ts';
import { cardModel } from './agenda-card-model.ts';
import { type SwipeMap, swipeMap } from './agenda-inbox.ts';
import { revisionStamp } from './agenda-revisions.ts';
import { agendaAuthor, parkedUntilWords } from './agenda-status.ts';
import { attachedGateView, type GateItem, gateViewOf, isPlanGate, toGateAction } from './gate-items.ts';

/** The view's parts, in the order they are drawn. */
export const ITEM_VIEW_PARTS = [
  'head',
  'premise',
  'detail',
  'references',
  'needs',
  'tabs',
  'conversation',
  'activity',
] as const;
export type ItemViewPart = (typeof ITEM_VIEW_PARTS)[number];

/** What each part is called on screen. */
export const PART_TITLES: Readonly<Record<Exclude<ItemViewPart, 'head' | 'premise'>, string>> = {
  detail: 'Detailed context',
  references: 'Terms and references',
  needs: 'What I need from you',
  tabs: 'The live document',
  conversation: 'Conversation',
  activity: 'Activity',
};

// ---------------------------------------------------------------------------------------------------
// 1. The head's two chips
// ---------------------------------------------------------------------------------------------------

/** Where the item stands, in the owner's words: who it waits on. */
export interface StateChip {
  readonly state: 'needs-you' | 'resting' | 'snoozed' | 'done';
  /** "Needs you", "Resting · waiting on Zoe", "Resting · working", "Snoozed until Thu 09:00", "Done". */
  readonly label: string;
}

/** The STATE chip: the protocol's one state, said the way the owner reads it. */
export const stateChip = (item: AgendaItem, ferret: string, now: number): StateChip => {
  const view = agendaState(item);
  switch (view.state) {
    case 'needs-you':
      return { state: 'needs-you', label: 'Needs you' };
    case 'resting':
      return {
        state: 'resting',
        label: view.sub === 'working' ? 'Resting · working' : `Resting · waiting on ${agendaAuthor(item, ferret)}`,
      };
    case 'snoozed': {
      const until = parkedUntilWords(item, now);
      return { state: 'snoozed', label: until === null ? 'Snoozed' : `Snoozed until ${until}` };
    }
    case 'done':
      return { state: 'done', label: 'Done' };
  }
};

/** What each stage is called on its chip and in the activity log. */
export const STAGE_WORDS: Readonly<Record<AgendaStage, string>> = {
  explainer: 'Explainer',
  question: 'Question',
  plan: 'Plan to approve',
  tracker: 'Tracker',
  test: 'Test',
  done: 'Done',
};

/**
 * The stage an item is at now. A standalone card gate from before stages is the card's own ask: a plan to approve
 * ("OK to build") or a card to test. Every other item reads its stage the protocol's one way (`agendaStage`).
 */
export const itemStage = (item: AgendaItem): AgendaStage => {
  const closed = (item as { readonly resolvedAt?: string }).resolvedAt !== undefined;
  if (item.stage === undefined && !closed && item.gate !== undefined) return isPlanGate(item) ? 'plan' : 'test';
  return agendaStage(item);
};

// ---------------------------------------------------------------------------------------------------
// 4. Terms and references, as one table
// ---------------------------------------------------------------------------------------------------

/**
 * One row of the terms and references table. A term says what it means; a link is named by its target (drawn by the one
 * reference renderer) and means its own `meaning` (`agenda.link-meaning.1`), else its label, else nothing.
 */
export type ReferenceRow =
  | { readonly kind: 'term'; readonly key: string; readonly term: string; readonly meaning: string }
  | {
      readonly kind: 'link';
      readonly key: string;
      readonly link: NonNullable<AgendaItem['links']>[number];
      /** What the link means: its own `meaning` (`agenda.link-meaning.1`), else its label; empty when it has neither. */
      readonly meaning: string;
    };

/** Every term, then every link, each once. Empty when the item names neither. */
export const referenceRows = (item: Pick<AgendaItem, 'terms' | 'links'>): readonly ReferenceRow[] => [
  ...(item.terms ?? []).map(
    (entry, index) =>
      ({ kind: 'term', key: `term:${String(index)}`, term: entry.term, meaning: entry.meaning }) as const,
  ),
  ...(item.links ?? []).map(
    (link, index) =>
      ({
        kind: 'link',
        key: `link:${String(index)}`,
        link,
        meaning: (link.meaning ?? link.label)?.trim() ?? '',
      }) as const,
  ),
];

// ---------------------------------------------------------------------------------------------------
// 6. Card asks
// ---------------------------------------------------------------------------------------------------

/**
 * ONE CARD ASK the item carries (test this, approve that): drawn inside "What I need from you" with ITS buttons. Today
 * the daemon mirrors a thread's card ask as `gateAttached`; a list, so a daemon that carries several (`cardAsks`,
 * `agenda.card-asks.1`) reads into the same section unchanged.
 */
export interface ItemCardAsk {
  /** The ask's own reference (`gate:F12:tested:3`): what keys it, and what an answer names. */
  readonly key: string;
  readonly gate: AgendaGate;
  /** The ask drawn as the gate item it would be: the same options, in the same directions, as every gate surface. */
  readonly view: GateItem;
  /** The card's How to test (Markdown), when the ask carries it. */
  readonly howToTest: string | null;
}

/**
 * The open card asks an item carries, oldest first. `howToTestFor` is where the card's How to test is read from: the board
 * the app already holds (the ask itself carries the card's id and lane, not its steps); absent or empty, the ask has none.
 */
export const itemCardAsks = (
  item: AgendaItem,
  howToTestFor?: (cardId: string) => string | null | undefined,
): readonly ItemCardAsk[] => {
  const steps = (cardId: string, wire: string | undefined): string | null => {
    const own = wire?.trim() ?? '';
    const written = own === '' ? (howToTestFor?.(cardId)?.trim() ?? '') : own;
    return written === '' ? null : written;
  };
  // Every open ask on the wire, each with the "how to try it" the daemon wrote (kept in line with the card), else the
  // board's steps. A daemon that sends no `cardAsks` reads as the one ask it mirrors (`gateAttached`).
  const open = askedCardAsks(item);
  if (open.length === 0) {
    const view = attachedGateView(item);
    return view === undefined
      ? []
      : [{ key: gateReference(view.gate), gate: view.gate, view, howToTest: steps(view.gate.cardId, undefined) }];
  }
  // In the order they are asked (`askedCardAsks`, the order the daemon's mirror reads too): an ask the owner said Not
  // yet to waits behind every ask still waiting for an answer, so the next one is reachable, and is asked again once the
  // others are answered.
  return open.flatMap(ask => {
    const view = gateViewOf(item, ask.gate);
    return view === undefined
      ? []
      : [{ key: gateReference(ask.gate), gate: ask.gate, view, howToTest: steps(ask.gate.cardId, ask.howToTest) }];
  });
};

// ---------------------------------------------------------------------------------------------------
// 9. The activity log
// ---------------------------------------------------------------------------------------------------

/** One grey line of the activity log. */
export interface ActivityLine {
  readonly key: string;
  /** Milliseconds; 0 when the instant cannot be read (it sorts first and says no time). */
  readonly at: number;
  readonly text: string;
  /** What else the line says, one entry each: what an edit changed. Never shortened. */
  readonly details: readonly string[];
}

const instant = (at: string | undefined): number => {
  const parsed = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** What a history entry says in the log: what happened, never the words (the words are the conversation's). */
const historyWords = (entry: AgendaHistoryEntry, ferret: string): string => {
  switch (entry.kind) {
    case 'needs-info':
      return 'You asked for more information';
    case 'discuss':
      return 'You asked to talk it through';
    case 'updated':
      // The daemon's one line when it closed a card with nothing to try (docs/agenda.md § Try it only when …).
      return nothingToTryLine(entry.note) ?? `${ferret} updated it`;
    case 'surfaced':
      return entry.note === undefined ? 'Brought to you' : `Brought to you: ${entry.note}`;
    case 'replied':
      return 'You replied';
    case 'gate-answered':
      return answeredWords(entry.note);
  }
};

/** "You answered", naming the card the answer moved once, as a plain reference ("You answered for &F12"). */
const answeredWords = (note: string | undefined): string => {
  const card = note === undefined ? undefined : parseGateReference(note)?.cardId;
  return card === undefined ? 'You answered' : `You answered for &${card}`;
};

/** What one stage entry says: the first is where the item started, every later one a move. */
const stageWords = (stage: AgendaStage, first: boolean): string =>
  stage === 'done' ? 'Marked done' : first ? `Started as ${STAGE_WORDS[stage]}` : `Moved to ${STAGE_WORDS[stage]}`;

/** The edit lines, from the history the view already reads: one per version, with what it changed. */
export interface RevisionLine {
  readonly key: string;
  readonly at: number;
  readonly version: number;
  readonly summary: readonly string[];
}

/**
 * THE ACTIVITY LOG, oldest first: every stage the item entered (so its history keeps each one), every edit with what
 * it changed, the item's own history lines, and where it rests or sleeps now. The owner's and the ferret's words are
 * the conversation's, never repeated here.
 */
export const activityLog = (
  item: AgendaItem,
  ferret: string,
  revisions: readonly RevisionLine[],
  now: number,
): readonly ActivityLine[] => {
  const author = agendaAuthor(item, ferret);
  const stages = (item.stages ?? []).map(
    (entry, index) =>
      ({
        key: `stage:${String(index)}`,
        at: instant(entry.at),
        text: stageWords(entry.stage, index === 0),
        details: [],
      }) as const,
  );
  const edits = revisions.map(
    revision =>
      ({
        key: revision.key,
        at: revision.at,
        text: `Updated to v${String(revision.version)}`,
        details: revision.summary,
      }) as const,
  );
  const history = (item.history ?? []).map(
    (entry, index) =>
      ({
        key: `history:${String(index)}`,
        at: instant(entry.at),
        text: historyWords(entry, author),
        details: [],
      }) as const,
  );
  const view = agendaState(item);
  const resting =
    view.state === 'resting' && item.resting?.at !== undefined
      ? [
          {
            key: 'resting',
            at: instant(item.resting.at),
            text:
              view.sub === 'working'
                ? `${author} took it on${item.resting.why === undefined ? '' : `: ${item.resting.why}`}`
                : `Waiting on ${author}`,
            details: [],
          },
        ]
      : [];
  const snoozedUntil = parkedUntilWords(item, now);
  const snoozed =
    view.state === 'snoozed' && item.parked !== undefined
      ? [
          {
            key: 'snoozed',
            at: instant(item.parked.at),
            text: `Snoozed${snoozedUntil === null ? '' : ` until ${snoozedUntil}`}`,
            details: [],
          },
        ]
      : [];
  return [...stages, ...edits, ...history, ...resting, ...snoozed]
    .map((line, order) => ({ line, order }))
    .sort((a, b) => a.line.at - b.line.at || a.order - b.order)
    .map(({ line }) => line);
};

/** When a log line happened, in the fewest words; empty when it has no time. */
export const activityStamp = (at: number, now: number): string =>
  at === 0 ? '' : revisionStamp(new Date(at).toISOString(), now);

// ---------------------------------------------------------------------------------------------------
// 10. The item's ONE ask (docs/agenda.md § One model: the agenda asks, the card shows)
// ---------------------------------------------------------------------------------------------------

/**
 * What the swipes and arrow keys answer when one card ask is the item's only answer: that ask's options in their
 * directions, each marked for the ask it answers. Empty for none or several, so a stray key never answers the wrong one.
 */
const cardAskSwipeMap = (asks: readonly ItemCardAsk[]): SwipeMap => {
  const [only] = asks;
  if (only === undefined || asks.length !== 1) return {};
  return Object.fromEntries(
    Object.entries(swipeMap(only.view)).map(([direction, action]) => [direction, toGateAction(action, only.gate)]),
  );
};

/**
 * HOW "WHAT I NEED FROM YOU" ASKS, for every item kind that carries card asks. The agenda item is the only place the owner
 * acts, and it has ONE answer row:
 *
 * - **The FIRST card ask is the answer row** (`asks`, one at most), drawn as the item's own "Try it" / "Approve" with
 *   one plain reference line naming the card — never a "Card &F12" heading. Any other card ask is named, asked next
 *   (`later`): one thing at a time, one row. It goes first because it is always answerable: the daemon refuses the
 *   item's own Done while a card ask is open.
 * - **An item with buttons of its own** (a choice, a to-do, a notice, Request changes) keeps its question on screen, but
 *   its buttons wait (`ownRowHeld`) and come back once the card ask is answered.
 * - The item's own ask line is kept when it says something the card ask does not (`ownLine`): a ferret's own question,
 *   its numbered questions or fields stay; the daemon's "Try it: …" line that only repeats the ask goes. "Type your
 *   answer below" is never said beside buttons.
 * - **Typed answer** (`typed`): when the one card ask is the WHOLE of the item's ask (no question, field or button of its
 *   own) and the host draws the box under the item, Good is one tap and what is typed is the other answer (Not good with
 *   the words, or Not yet at an approval).
 */
export interface ItemAskPlan {
  readonly asks: readonly ItemCardAsk[];
  readonly later: readonly ItemCardAsk[];
  readonly ownLine: boolean;
  /** The item's own buttons wait behind the card ask: drawn again once it is answered. */
  readonly ownRowHeld: boolean;
  readonly typed: ItemCardAsk | undefined;
  readonly swipes: SwipeMap | undefined;
}

const NO_CARD_ASKS: ItemAskPlan = {
  asks: [],
  later: [],
  ownLine: true,
  ownRowHeld: false,
  typed: undefined,
  swipes: undefined,
};

/** Whether the item answers on buttons of its own (the row the view draws for it). */
const hasOwnRow = (item: AgendaItem): boolean => {
  const model = cardModel(item);
  return model.notice || model.answers.length > 0 || model.requestChanges !== undefined;
};

export const itemAskPlan = (
  item: AgendaItem,
  asks: readonly ItemCardAsk[],
  options: { readonly typedHost?: boolean } = {},
): ItemAskPlan => {
  const [first, ...rest] = asks;
  if (first === undefined) return NO_CARD_ASKS;
  // The card ask is asked FIRST: the daemon refuses the item's own Done while one is open, and always takes the ask's
  // answer, so an item's own buttons wait behind it and come back once it is answered (never the other way round).
  const ownRow = hasOwnRow(item);
  // The ONE rule the daemon reads too (`itemAsksOwnQuestion`): the item keeps its line when it asks something the card
  // asks do not, so an item shown asking stays in Needs you after the card ask is answered.
  const ownLine = itemAsksOwnQuestion(item, asks);
  // Typed words answer the card ask only when it is the item's WHOLE ask: no question, field or button of the item's
  // own, and no other ask behind it. Anything the item asks itself keeps the box as its reply.
  const whole = !ownRow && !ownLine && rest.length === 0;
  const typed = options.typedHost === true && whole && gateTypedLabel(first.gate) !== undefined ? first : undefined;
  return { asks: [first], later: rest, ownLine, ownRowHeld: ownRow, typed, swipes: cardAskSwipeMap([first]) };
};

/**
 * The open card ask the words typed under this item answer (the Inbox's box), or `undefined`: the one the view draws as
 * the item's whole ask, Good-only. The Inbox's composer and the item view read this one function, so the box answers
 * exactly the ask the view says it does.
 */
export const typedCardAsk = (
  item: AgendaItem,
  howToTestFor?: (cardId: string) => string | null | undefined,
): AgendaCardAsk | undefined => {
  const typed = itemAskPlan(item, itemCardAsks(item, howToTestFor), { typedHost: true }).typed;
  return typed === undefined ? undefined : openCardAsks(item).find(ask => gateReference(ask.gate) === typed.key);
};

/** Whether the item is a notice about cards, answered by its one form (`AgendaCardsList`) and nothing else. */
export const answersWithCardsForm = (item: Pick<AgendaItem, 'cards'>): boolean => (item.cards?.length ?? 0) > 0;

/**
 * What each swipe direction answers on this item, for every surface that swipes it (the item view, the Inbox deck, the
 * run's key hints): the first card ask's options, each marked for that ask, while one is open — the item's own buttons
 * wait behind it — else the item's own answers. One function, so a swipe on the deck and a tap in the view always answer
 * the same ask. A notice about cards answers with its one form's Send, so it swipes to nothing: a swipe or key that
 * said Got it would skip every pick on it.
 */
export const itemSwipeTargets = (item: AgendaItem): SwipeTargets => {
  if (answersWithCardsForm(item)) return {};
  const [first] = itemAskPlan(item, itemCardAsks(item)).asks;
  if (first === undefined) return swipeTargets(item);
  return Object.fromEntries(
    Object.entries(swipeTargets(first.view)).map(([direction, target]) => [
      direction,
      target === undefined || target.action === null
        ? target
        : { ...target, action: toGateAction(target.action, first.gate) },
    ]),
  );
};
