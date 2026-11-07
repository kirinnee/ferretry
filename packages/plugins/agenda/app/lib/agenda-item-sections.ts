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
  type AgendaGate,
  type AgendaHistoryEntry,
  type AgendaItem,
  type AgendaStage,
  agendaStage,
  agendaState,
  gateReference,
} from '../wire/index.ts';
import { revisionStamp } from './agenda-revisions.ts';
import { agendaAuthor, parkedUntilWords } from './agenda-status.ts';
import { attachedGateView, type GateItem, isPlanGate, gateOf } from './gate-items.ts';

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
  if (item.stage === undefined && !closed && gateOf(item) !== undefined) return isPlanGate(item) ? 'plan' : 'test';
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
  const view = attachedGateView(item);
  if (view === undefined) return [];
  const steps = howToTestFor?.(view.gate.cardId)?.trim() ?? '';
  return [{ key: gateReference(view.gate), gate: view.gate, view, howToTest: steps === '' ? null : steps }];
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
      return `${ferret} updated it`;
    case 'surfaced':
      return entry.note === undefined ? 'Brought to you' : `Brought to you: ${entry.note}`;
    case 'replied':
      return 'You replied';
    case 'gate-answered':
      return entry.note === undefined ? 'You answered a card ask' : `You answered the card ask ${entry.note}`;
  }
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
