/**
 * WHAT A CARD'S DETAIL SAYS, AS PLAIN VALUES.
 *
 * The drawer draws; this file decides. The lane stepper (where the card is, among its project's lanes),
 * the history rows (what happened, in words, with the boring runs folded), the PR and release lines, the
 * two answers a card in 🧪 To test waits for, and the two messages the owner sends a ferret from
 * the detail. Nothing here reads the clock or the network, so every state is a value-to-value test.
 */

import {
  attachmentsPhrase,
  type AgendaItem,
  type AgendaRef,
  type AgendaSnapshot,
  ADMIN_TOKEN_ACTOR_NOTE,
  ADMIN_TOKEN_ACTOR_WORDS,
  boardEventActor,
  type BoardActor,
  type BoardActorVia,
  type BoardEditableField,
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
import { type DeclaredLanes, doneLaneOf, notGoodLaneOf } from './board-done.ts';
import type { FerretNames } from './board-present.ts';

type Lanes = Pick<LaneSet, 'lanes'>;

export const laneCategoryOf = (laneSet: Lanes | null, laneId: string): LaneCategory | null =>
  laneSet?.lanes.find(lane => lane.id === laneId)?.category ?? null;

export const laneNameOf = (laneSet: Lanes | null, laneId: string): string =>
  laneSet?.lanes.find(lane => lane.id === laneId)?.name ?? laneId;

// ---------------------------------------------------------------------------------------------------
// The two answers of a card waiting to be tried
// ---------------------------------------------------------------------------------------------------

export interface VerdictLanes {
  /** "✓ Done": the Done lane (`doneLaneOf`), a move forward that needs no words. */
  readonly closeLaneId: string | null;
  /** "✗ Not good → Implement": the Not good lane (`notGoodLaneOf`), a move back that asks why. */
  readonly reworkLaneId: string | null;
}

/** The lanes the two verdict buttons go to; `null` when the card is not in a 🧪 verify lane. */
export const verdictLanes = (laneSet: (Lanes & DeclaredLanes) | null, laneId: string): VerdictLanes | null => {
  if (laneSet === null || laneCategoryOf(laneSet, laneId) !== 'verify') return null;
  return { closeLaneId: doneLaneOf(laneSet), reworkLaneId: notGoodLaneOf(laneSet) };
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

const actorName = (actor: BoardActor, via: BoardActorVia | undefined, names: FerretNames): string => {
  if (actor.kind === 'owner') return via === 'admin-token' ? 'Admin token' : 'You';
  if (actor.kind === 'daemon') return 'Ferretry';
  return names(actor.sessionId);
};

export interface HistoryRow {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  /** What the actor may be, when its name alone would mislead — the admin token may be a ferret — or null. */
  readonly actorNote: string | null;
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
    case 'moved': {
      const moved = `${lane(event.from)} → ${lane(event.to)}`;
      if (event.reportedBy !== undefined) {
        // Somebody's word, carried out by Ferretry: it reads as theirs, never as a fact Ferretry saw.
        return {
          text: `reported ${event.trigger ?? 'a trigger'} → moved ${moved}`,
          detail: event.reason,
          minor: false,
        };
      }
      return {
        text: `${event.auto === true ? 'moved automatically' : event.backward ? 'moved back' : 'moved'} ${moved}`,
        detail: event.reason,
        minor: false,
      };
    }
    case 'reopened':
      return {
        // The files the owner sent with it are part of what happened: "reopened To test → Implement with 2 images".
        text: `reopened ${lane(event.from)} → ${lane(event.to)}${
          event.attachments === undefined ? '' : ` with ${attachmentsPhrase(event.attachments)}`
        }`,
        detail: event.reason,
        minor: false,
      };
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
      return { text: `edited ${FIELD_WORDS[event.field]}`, detail: null, minor: true };
    case 'file-claimed':
      return { text: `claimed ${event.path}`, detail: null, minor: true };
    case 'file-released':
      return { text: `released ${event.path}`, detail: event.reason, minor: true };
    case 'ordered':
      return { text: 'reordered it in its lane', detail: null, minor: true };
    case 'refiled':
      return { text: 'moved it to another project', detail: event.reason, minor: false };
    case 'reparented':
      return {
        text:
          event.to === null
            ? `made it a top-level card (was under ${event.from === null ? 'nothing' : refText(event.from)})`
            : `moved it under ${refText(event.to)}${event.from === null ? ' (was top level)' : ` (was under ${refText(event.from)})`}`,
        detail: event.reason,
        minor: false,
      };
    case 'snoozed':
      return {
        text: event.until === null ? 'woke it from snooze' : `snoozed it until ${event.until}`,
        detail: null,
        minor: true,
      };
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
    .map(event => {
      const { actor, via } = boardEventActor(event);
      return {
        seq: event.seq,
        at: event.at,
        actor: actorName(actor, via, context.names),
        actorNote: actor.kind === 'owner' && via === 'admin-token' ? ADMIN_TOKEN_ACTOR_NOTE : null,
        type: event.type,
        ...describe(event, context),
      };
    });

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

/** An answered or dismissed ask, with the ferret whose ledger keeps it — the card a click opens is its. */
interface ResolvedAskRow {
  readonly sessionId: string;
  readonly item: ResolvedAgendaItem;
}

export interface CardAsks {
  readonly open: readonly OpenAskRow[];
  /** Asks about this card that are answered or dismissed, newest first. */
  readonly resolved: readonly ResolvedAskRow[];
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
    .flatMap(entry => (entry.snapshot?.resolved ?? []).map(item => ({ sessionId: entry.sessionId, item })))
    .filter(({ item }) => item.task?.id === task.id && (item.task.machineId ?? task.machineId) === task.machineId)
    .sort((a, b) => b.item.resolvedAt.localeCompare(a.item.resolvedAt));
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

// ---------------------------------------------------------------------------------------------------
// What is worth a section, and who said the ask
// ---------------------------------------------------------------------------------------------------

/** A prose field the card actually has; an empty one earns no section. */
export const written = (text: string): boolean => text.trim() !== '';

/** How to test, as the owner reads it: an optional lead line ("On the Mac, v4.157:"), then the steps in order. */
export interface TestSteps {
  readonly lead: string | null;
  readonly steps: readonly string[];
}

const LIST_ITEM = /^( {0,3}(?:\d{1,3}[.)]|[-*+])\s+)(.*)$/u;
const FENCE = /^\s*(?:```|~~~)/u;

interface StepLines {
  /** How far the step's own text is indented: its continuation lines lose this much. */
  readonly indent: number;
  readonly lines: string[];
}

const dedent = (line: string, indent: number): string => {
  const spaces = /^ */u.exec(line)?.[0].length ?? 0;
  return line.slice(Math.min(spaces, indent));
};

/**
 * How to test split into steps when it is written as a list (numbered or bulleted), each step keeping its own
 * continuation lines (an indented code block, a second paragraph). Text before the list is its lead. `null` when
 * it is not a list, or text follows the list: then it is drawn whole, as Markdown, rather than cut up wrongly.
 */
export const testSteps = (text: string): TestSteps | null => {
  const lead: string[] = [];
  const steps: StepLines[] = [];
  let fence = false;
  for (const line of text.trim().split('\n')) {
    const current = steps.at(-1);
    const item = fence ? null : LIST_ITEM.exec(line);
    if (item !== null) {
      steps.push({ indent: item[1]?.length ?? 0, lines: [item[2] ?? ''] });
      continue;
    }
    if (current === undefined) {
      lead.push(line);
      continue;
    }
    const indented = (/^ */u.exec(line)?.[0].length ?? 0) >= Math.min(current.indent, 2);
    if (!fence && line.trim() !== '' && !indented) return null;
    current.lines.push(dedent(line, current.indent));
    if (FENCE.test(line)) fence = !fence;
  }
  if (steps.length === 0) return null;
  const leadText = lead.join('\n').trim();
  return {
    lead: leadText === '' ? null : leadText,
    steps: steps.map(step => step.lines.join('\n').trim()),
  };
};

/** What the history calls each field an edit changed. */
const FIELD_WORDS: Readonly<Record<BoardEditableField, string>> = {
  title: 'the title',
  summary: 'the summary',
  premise: 'the premise',
  context: 'the context',
  terms: 'the terms',
  brief: 'the brief',
  howToTest: 'How to test',
};

/** The card has a PR, a branch, a doc or a release to show. */
export const hasLinks = (task: Pick<BoardTaskView, 'links' | 'shippedIn'>): boolean =>
  task.links.prs.length > 0 || task.links.branch !== null || task.links.docs.length > 0 || task.shippedIn !== null;

/** Who said the ask and where, in the parts the section strings together. */
export interface AskOrigin {
  /** "you", a ferret's name or "the daemon"; the section writes "from" before it. */
  readonly who: string;
  /** The session the ask was said in, to link to; `null` when the source is not a session. */
  readonly sessionId: string | null;
  /** "denisha's chat", set when `sessionId` is. */
  readonly chat: string | null;
  /** A source that is neither a session nor the owner's own words, kept verbatim. */
  readonly via: string | null;
  readonly age: string | null;
}

const SESSION_SOURCE = 'session:';

export const askOrigin = (
  task: Pick<BoardTaskView, 'ask' | 'createdBy' | 'createdByVia' | 'createdAt'>,
  names: FerretNames,
  age: string | null,
): AskOrigin => {
  const { source } = task.ask;
  const sessionId = source.startsWith(SESSION_SOURCE) ? source.slice(SESSION_SOURCE.length) : null;
  const author = task.createdBy;
  return {
    who: askAuthor(author, task.createdByVia, names),
    sessionId,
    chat: sessionId === null ? null : `${names(sessionId)}'s chat`,
    via: sessionId === null && !/^owner/iu.test(source) ? source : null,
    age,
  };
};

/** Who opened a card, as its byline says it. The admin token is said for what it is: it may be either. */
const askAuthor = (author: BoardActor, via: BoardActorVia | undefined, names: FerretNames): string => {
  if (author.kind === 'owner') return via === 'admin-token' ? ADMIN_TOKEN_ACTOR_WORDS : 'you';
  if (author.kind === 'ferret') return names(author.sessionId);
  return 'the daemon';
};

const RAW_PREFIX = /^\s*\([^()\n]{1,60}\)\s*/u;

/**
 * The ask as the owner reads it: a ferret opening a card on someone's behalf leaves a raw note in front of the
 * words ("(sada, found live) Fix the thing"); the byline already says who, so the note is dropped. Words that
 * are only a parenthesis stay as they are.
 */
export const askWords = (text: string): string => {
  const rest = text.replace(RAW_PREFIX, '');
  return rest.trim() === '' ? text.trim() : rest.trim();
};
