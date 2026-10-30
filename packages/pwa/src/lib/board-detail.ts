/**
 * WHAT A CARD'S DETAIL SAYS, AS PLAIN VALUES.
 *
 * The drawer draws; this file decides. The lane stepper (where the card is, among its project's lanes),
 * the history rows (what happened, in words, with the boring runs folded), the PR and release lines, the
 * two answers a card in 🧪 Manually tested waits for, and the two messages the owner sends a ferret from
 * the detail. Nothing here reads the clock or the network, so every state is a value-to-value test.
 */

import {
  type AgendaItem,
  type AgendaRef,
  type AgendaSnapshot,
  type BoardActor,
  type BoardTaskEvent,
  type BoardTaskView,
  formatTaskRef,
  type LaneCategory,
  type LaneSet,
  MAX_BOARD_NOTE_LENGTH,
  type PrLink,
  type ResolvedAgendaItem,
  type TaskRef,
} from '@ferretry/protocol';
import type { FerretNames } from './board-present.ts';

type Lanes = Pick<LaneSet, 'lanes'>;

// ---------------------------------------------------------------------------------------------------
// The lane stepper
// ---------------------------------------------------------------------------------------------------

export interface LaneStep {
  readonly id: string;
  readonly name: string;
  readonly category: LaneCategory;
  /** `done` is behind the card, `current` is where it is, `next` is ahead. */
  readonly state: 'done' | 'current' | 'next';
}

/**
 * The project's lanes in order with the card's place among them; the Closed lane is always last. A card in a
 * lane the set does not have (a lane edit after it moved) has no `current` step and every step reads `next`.
 */
export const laneStepper = (laneSet: Lanes | null, laneId: string): readonly LaneStep[] => {
  if (laneSet === null) return [];
  const ordered = [
    ...laneSet.lanes.filter(lane => lane.category !== 'closed'),
    ...laneSet.lanes.filter(lane => lane.category === 'closed'),
  ];
  const at = ordered.findIndex(lane => lane.id === laneId);
  return ordered.map((lane, index) => ({
    id: lane.id,
    name: lane.name,
    category: lane.category,
    state: at < 0 ? 'next' : index < at ? 'done' : index === at ? 'current' : 'next',
  }));
};

export const laneCategoryOf = (laneSet: Lanes | null, laneId: string): LaneCategory | null =>
  laneSet?.lanes.find(lane => lane.id === laneId)?.category ?? null;

export const laneNameOf = (laneSet: Lanes | null, laneId: string): string =>
  laneSet?.lanes.find(lane => lane.id === laneId)?.name ?? laneId;

// ---------------------------------------------------------------------------------------------------
// The two answers of a card waiting to be tried
// ---------------------------------------------------------------------------------------------------

export interface VerdictLanes {
  /** "✓ Works → Close": the Closed lane, a move forward that needs no words. */
  readonly closeLaneId: string | null;
  /** "✗ Not good → Implement": the last active lane, a move back that asks why. */
  readonly reworkLaneId: string | null;
}

/** The lanes the two verdict buttons go to; `null` when the card is not in a 🧪 verify lane. */
export const verdictLanes = (laneSet: Lanes | null, laneId: string): VerdictLanes | null => {
  if (laneSet === null || laneCategoryOf(laneSet, laneId) !== 'verify') return null;
  const active = laneSet.lanes.filter(lane => lane.category === 'active');
  return {
    closeLaneId: laneSet.lanes.find(lane => lane.category === 'closed')?.id ?? null,
    reworkLaneId: active[active.length - 1]?.id ?? null,
  };
};

// ---------------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------------

export const kindLabel = (kind: BoardTaskView['kind']): string =>
  ({ bug: 'Bug', feature: 'Feature', infra: 'Infra', chore: 'Chore' })[kind];

/** The words for the card's liveness; a card in a verify lane waits for the owner, whatever it derived. */
export const activityText = (
  task: Pick<BoardTaskView, 'activity' | 'waitingOnOwner'>,
  category: LaneCategory | null,
): string => {
  if (category === 'verify') return 'Waiting for you to try it';
  switch (task.activity) {
    case 'active':
      return 'A ferret is working on it';
    case 'idle':
      return 'Idle';
    case 'stale':
      return 'Stale: idle longer than its lane allows';
    case 'waiting':
      return task.waitingOnOwner.length > 0 ? 'Stopped until you answer' : 'Waiting on something outside the ferret';
    case 'orphaned':
      return 'No ferret is left on it';
  }
};

// ---------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------

export interface PrLine {
  readonly pr: PrLink;
  /** `Merged`, `Draft`, `Open`, `Closed`, or `Not polled yet`. */
  readonly state: string;
  /** `CI green`, `CI red`, `CI running`, or `null` when checks do not apply. */
  readonly checks: string | null;
  readonly tone: 'ok' | 'warn' | 'err' | 'pend' | 'quiet';
}

export const prLine = (pr: PrLink): PrLine => {
  if (pr.state === 'merged') return { pr, state: 'Merged', checks: null, tone: 'ok' };
  if (pr.state === 'closed') return { pr, state: 'Closed', checks: null, tone: 'quiet' };
  if (pr.state === 'unknown') return { pr, state: 'Not polled yet', checks: null, tone: 'quiet' };
  const state = pr.draft ? 'Draft' : 'Open';
  if (pr.checks === 'failing') return { pr, state, checks: 'CI red', tone: 'err' };
  if (pr.checks === 'pending') return { pr, state, checks: 'CI running', tone: 'pend' };
  if (pr.checks === 'passing') return { pr, state, checks: 'CI green', tone: 'ok' };
  return { pr, state, checks: null, tone: 'quiet' };
};

/** A branch or doc link as short as it can be read: a GitHub URL to `owner/repo#N` or its last path part. */
export const linkLabel = (value: string): string => {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(part => part !== '');
    return parts.length === 0 ? url.host : (parts[parts.length - 1] ?? url.host);
  } catch {
    return value;
  }
};

/** A link worth opening: only `http(s)` is ever turned into an anchor. */
export const isWebLink = (value: string): boolean => /^https?:\/\//iu.test(value);

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

export interface HistoryContext {
  readonly names: FerretNames;
  readonly laneName: (laneId: string) => string;
}

const actorName = (actor: BoardActor, names: FerretNames): string => {
  if (actor.kind === 'owner') return 'You';
  if (actor.kind === 'daemon') return 'Ferretry';
  return names(actor.sessionId);
};

export interface HistoryRow {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  /** What happened, one line, without the actor. */
  readonly text: string;
  /** The reason or note behind it, when there is one. */
  readonly detail: string | null;
  /** A row the page folds into a run when several come together. */
  readonly minor: boolean;
  readonly type: BoardTaskEvent['type'];
}

const refText = (ref: TaskRef): string => formatTaskRef(ref);

const describe = (event: BoardTaskEvent, context: HistoryContext): Pick<HistoryRow, 'text' | 'detail' | 'minor'> => {
  const lane = context.laneName;
  switch (event.type) {
    case 'created':
      return { text: `opened it in ${lane(event.laneId)}`, detail: null, minor: false };
    case 'moved':
      return {
        text: `${event.auto === true ? 'moved automatically' : event.backward ? 'moved back' : 'moved'} ${lane(event.from)} → ${lane(event.to)}`,
        detail: event.reason,
        minor: false,
      };
    case 'reopened':
      return { text: `reopened ${lane(event.from)} → ${lane(event.to)}`, detail: event.reason, minor: false };
    case 'note':
      return { text: 'noted', detail: event.text, minor: false };
    case 'clarified':
      return { text: 'clarified the ask', detail: event.text, minor: false };
    case 'linked':
      return { text: `linked a ${event.field}`, detail: event.value, minor: true };
    case 'assigned':
      return {
        text:
          event.to === null
            ? 'took the assignee off'
            : `assigned it to ${context.names(event.to)}${event.from === null ? '' : ` (was ${context.names(event.from)})`}`,
        detail: null,
        minor: false,
      };
    case 'depended':
      return {
        text: `now waits for ${refText(event.task)} to be ${event.until}`,
        detail: event.override === undefined ? null : `Overridden: ${event.override.reason}`,
        minor: false,
      };
    case 'undepended':
      return { text: `no longer waits for ${refText(event.task)}`, detail: event.reason, minor: false };
    case 'blocked':
      return { text: 'blocked', detail: event.reason, minor: false };
    case 'unblocked':
      return { text: 'unblocked', detail: event.reason, minor: false };
    case 'field-edited':
      return { text: `edited the ${event.field}`, detail: null, minor: true };
    case 'file-claimed':
      return { text: `claimed ${event.path}`, detail: null, minor: true };
    case 'file-released':
      return { text: `released ${event.path}`, detail: event.reason, minor: true };
    case 'ordered':
      return { text: 'reordered it in its lane', detail: null, minor: true };
    case 'refiled':
      return { text: 'moved it to another project', detail: event.reason, minor: false };
    case 'dropped':
      return { text: 'dropped it', detail: event.reason, minor: false };
    case 'migrated':
      return { text: `brought it over from ${event.legacyRef}`, detail: null, minor: false };
  }
};

/** Every event as a row, newest first. */
export const historyRows = (history: readonly BoardTaskEvent[], context: HistoryContext): readonly HistoryRow[] =>
  [...history]
    .sort((a, b) => b.seq - a.seq)
    .map(event => ({
      seq: event.seq,
      at: event.at,
      actor: actorName(event.actor, context.names),
      type: event.type,
      ...describe(event, context),
    }));

export type HistoryItem =
  | { readonly kind: 'row'; readonly row: HistoryRow }
  /** A run of minor events (edits, file claims, links), folded into one line until opened. */
  | { readonly kind: 'fold'; readonly rows: readonly HistoryRow[]; readonly label: string };

/** The shortest run of minor events that is folded; two stay as rows, which is shorter than the fold. */
export const FOLD_MINIMUM = 3;

/** Folds each run of at least {@link FOLD_MINIMUM} minor rows into one item. */
export const foldHistory = (rows: readonly HistoryRow[]): readonly HistoryItem[] => {
  const items: HistoryItem[] = [];
  let run: HistoryRow[] = [];
  const flush = (): void => {
    if (run.length >= FOLD_MINIMUM) {
      items.push({ kind: 'fold', rows: run, label: `${run.length} small changes` });
    } else {
      for (const row of run) items.push({ kind: 'row', row });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.minor) {
      run.push(row);
      continue;
    }
    flush();
    items.push({ kind: 'row', row });
  }
  flush();
  return items;
};

// ---------------------------------------------------------------------------------------------------
// Asks
// ---------------------------------------------------------------------------------------------------

/** The card's open asks that are NOT also stopping the ferret: the rest of `openAsks`. */
export const nonBlockingAsks = (task: Pick<BoardTaskView, 'openAsks' | 'waitingOnOwner'>): readonly AgendaRef[] =>
  task.openAsks.filter(ask => !task.waitingOnOwner.some(waiting => waiting.id === ask.id));

// ---------------------------------------------------------------------------------------------------
// Messages the owner sends
// ---------------------------------------------------------------------------------------------------

/** The tag a comment to the ferret carries, so it can tell which card the words are about. */
export const commentTag = (task: Pick<BoardTaskView, 'id'>): string => `[re ${formatTaskRef({ id: task.id })}]`;

/** What the ferret is sent: the owner's words under the card's tag. */
export const ferretComment = (task: Pick<BoardTaskView, 'id'>, text: string): string =>
  `${commentTag(task)} ${text.trim()}`;

/** The history note recorded beside a comment; bounded the way a note is. */
export const commentNote = (text: string): string => text.trim().slice(0, MAX_BOARD_NOTE_LENGTH);

/** The brief a ferret started from "+ Card" is given: the title and the ask, as the owner wrote them. */
export const startBrief = (draft: NewCardDraft): string =>
  `${draft.title.trim()}\n\n${draft.ask.trim()}\n\nThe owner is opening a board card for this work and will tell you its id.`;

/** The first message a started ferret gets once its card exists: which card is its own. */
export const assignedMessage = (task: Pick<BoardTaskView, 'id' | 'title'>): string =>
  `${commentTag(task)} The owner assigned this card to you: ${task.title}. Keep it current as you work.`;

// ---------------------------------------------------------------------------------------------------
// "+ Card"
// ---------------------------------------------------------------------------------------------------

export interface NewCardDraft {
  readonly title: string;
  readonly ask: string;
}

export type NewCardProblem = 'title-empty' | 'title-long' | 'ask-empty' | 'assignee-missing';

const MAX_TITLE_WORDS = 5;

/** What stops a new card being sent, in the order the form shows it; empty when it is ready. */
export const newCardProblems = (draft: NewCardDraft, assignee: string | null): readonly NewCardProblem[] => {
  const problems: NewCardProblem[] = [];
  const title = draft.title.trim();
  if (title === '') problems.push('title-empty');
  else if (title.split(/\s+/u).length > MAX_TITLE_WORDS) problems.push('title-long');
  if (draft.ask.trim() === '') problems.push('ask-empty');
  if (assignee === null) problems.push('assignee-missing');
  return problems;
};

export const NEW_CARD_PROBLEM_TEXT: Readonly<Record<NewCardProblem, string>> = {
  'title-empty': 'Give it a title.',
  'title-long': 'Keep the title to five words.',
  'ask-empty': 'Say what you want done.',
  'assignee-missing': 'Pick who does it, or start a ferret on it.',
};

/** The source recorded with the ask a card is opened with from the Board. */
export const OWNER_CARD_SOURCE = 'owner (board)';

// ---------------------------------------------------------------------------------------------------
// The card's asks, joined to the agenda
// ---------------------------------------------------------------------------------------------------

/** One ferret's agenda, as read: `null` until it has been. */
export interface SessionAgenda {
  readonly sessionId: string;
  readonly snapshot: AgendaSnapshot | null;
}

export interface OpenAskRow {
  readonly ref: AgendaRef;
  /** `null` while the ferret's agenda is still being read, or when it no longer lists the ask. */
  readonly item: AgendaItem | null;
  /** The ask stops the ferret until the owner answers. */
  readonly blocking: boolean;
}

export interface CardAsks {
  readonly open: readonly OpenAskRow[];
  /** Asks about this card that are answered or dismissed, newest first. */
  readonly resolved: readonly ResolvedAgendaItem[];
  /** The agendas are still being read: an empty list is not yet "no asks". */
  readonly reading: boolean;
}

/**
 * The card's open asks (from its own `openAsks`, so none is missed) and its resolved ones (the agenda's
 * ledger, which is the only place an answered ask is kept). The card says WHICH asks are open; the ferret's
 * agenda says what each one is.
 */
export const collectAsks = (task: BoardTaskView, agendas: readonly SessionAgenda[]): CardAsks => {
  const itemOf = (ref: AgendaRef): AgendaItem | null =>
    agendas.find(entry => entry.sessionId === ref.sessionId)?.snapshot?.items.find(item => item.id === ref.id) ?? null;
  const resolved = agendas
    .flatMap(entry => entry.snapshot?.resolved ?? [])
    .filter(item => item.task?.id === task.id && (item.task.machineId ?? task.machineId) === task.machineId)
    .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
  return {
    open: task.openAsks.map(ref => ({
      ref,
      item: itemOf(ref),
      blocking: task.waitingOnOwner.some(waiting => waiting.sessionId === ref.sessionId && waiting.id === ref.id),
    })),
    resolved,
    reading: agendas.some(entry => entry.snapshot === null),
  };
};

/** The ferrets whose agendas can hold this card's asks: the ones that raised an open ask, the owner, the assignee. */
export const askSessions = (task: Pick<BoardTaskView, 'openAsks' | 'owner' | 'assignee'>): readonly string[] => [
  ...new Set([
    ...task.openAsks.map(ask => ask.sessionId),
    task.owner,
    ...(task.assignee === null ? [] : [task.assignee]),
  ]),
];
