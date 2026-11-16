/**
 * ORPHANED CARDS: the Warden's one anomaly about a CARD rather than a ferret (`board-design.md` §3.3, §3.4).
 *
 * ═══ WHAT ORPHANED MEANS ═══
 *
 * A card in an active or review lane whose ferret is finished (or gone from this machine), with no live
 * ferret anywhere under it. The board derives that (`board/activity.ts`, `activity: 'orphaned'`) and this
 * module never decides it again: it reads the board's word, so the card drawn red on the board and the
 * card the Warden reports are always the same cards.
 *
 * ═══ WHO IS TOLD ═══
 *
 * Nothing is investigated: the fault is categorical, and its remedy is somebody picking the card up. So:
 *
 * 1. the card's OWNER ferret, when it is alive and is not the finished ferret itself, gets a queued
 *    message through the ordinary send path: resume the ferret, hand the card on, or drop it;
 * 2. otherwise the owner (the person) is told by the ONE machine item that lists every such card
 *    (`orphan-item.ts`, v4's single list): a card joins it when no live owner ferret can be told, and leaves it
 *    when a ferret is on the card again. Never one ask per card: a board holds 20 unresolved items.
 *
 * Once per EPISODE: one card left by one ferret. The Warden remembers whom it told
 * ({@link OrphanMemory}); a card still orphaned is not told again, except that a message to an owner
 * ferret that has since finished too moves on to the list. A card that is no longer orphaned is
 * forgotten and drops off the list: when it is orphaned again it is news again.
 *
 * Pure: the board, the fleet and the memory arrive through the arguments.
 */
import { type CardId, type CardView, formatCardRef, type LaneSet } from '@ferretry/plugin-board/contract';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { AGENDA_PUSH_BODY_LENGTH, clipAtWord } from './protocol.ts';
import { inWardenLineage, type WardenAnomaly } from './detect.ts';
import { wardenTeammateToken } from './prompt.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** Every board's lanes, by project id. */
type LaneSets = ReadonlyMap<string, LaneSet>;

/** Every card as the board derives it, with every board's lanes: one read per sweep. */
export interface WardenBoardRead {
  readonly views: readonly CardView[];
  readonly laneSets: LaneSets;
}

/** The card's working ferret: the assignee, else the owner (Board's rule: a `null` assignee reads as the owner). */
const effectiveAssignee = (card: Pick<CardView, 'owner' | 'assignee'>): string => card.assignee ?? card.owner;

/** The anomaly identity of an orphaned card: about the card, so two cards one ferret left are two flags. */
export const orphanFleetKey = (id: CardId): string => `card:${id}`;

/**
 * The source reference of the per-card ask an earlier Warden raised on a ferret's board (`warden-orphan:<card>`): only
 * read now, to close what such a board still holds ({@link OrphanPlan.resolve}).
 */
const orphanCardAskRef = (id: CardId): string => `warden-orphan:${id}`;

const laneName = (board: WardenBoardRead, view: CardView): string =>
  board.laneSets.get(view.projectId)?.lanes.find(lane => lane.id === view.laneId)?.name ?? view.laneId;

/** A ferret as a reference a reader's client can prove and link: its callsign, else its bare id. */
const ferretRef = (sessionId: string, fleet: ReadonlyMap<string, WardenSessionView>): string => {
  const teammate = fleet.get(sessionId)?.config.teammate;
  return teammate === undefined ? sessionId : wardenTeammateToken(teammate);
};

/** What became of a card's ferret, in words: its terminal status, or that it is gone. */
const endedAs = (sessionId: string, fleet: ReadonlyMap<string, WardenSessionView>): string => {
  const session = fleet.get(sessionId);
  return session === undefined ? 'no longer on this machine' : session.state.status;
};

// ── Detection ────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `orphaned_card` anomaly per card the board calls orphaned. A card a warden (or anything a warden
 * spawned) was left holding is not flagged: the Warden never reports its own lineage.
 */
export function detectOrphanedCards(
  board: WardenBoardRead,
  sessions: readonly WardenSessionView[],
  nowMs: number,
): readonly WardenAnomaly[] {
  const fleet = new Map(sessions.map(session => [session.config.id, session]));
  const anomalies: WardenAnomaly[] = [];
  for (const view of board.views) {
    if (view.activity !== 'orphaned') continue;
    const assignee = effectiveAssignee(view);
    const session = fleet.get(assignee);
    if (session !== undefined && inWardenLineage(session, fleet)) continue;
    const since = view.lastTouchedAt ?? view.createdAt;
    const sinceMs = instantMs(since);
    const idleMinutes = sinceMs === undefined || nowMs < sinceMs ? undefined : Math.floor((nowMs - sinceMs) / 60_000);
    anomalies.push({
      kind: 'orphaned_card',
      sessionId: assignee,
      fleetKey: orphanFleetKey(view.id),
      task: { id: view.id },
      ...(session?.config.teammate === undefined ? {} : { teammate: session.config.teammate }),
      ...(session?.config.label === undefined ? {} : { label: session.config.label }),
      // A ferret gone from this machine has no status left to report; `stopped` is the honest nearest.
      status: session?.state.status ?? 'stopped',
      detail: `${formatCardRef(view)} “${view.title}” is in ${laneName(board, view)}, but its ferret ${ferretRef(assignee, fleet)} is ${endedAs(assignee, fleet)} and nothing under it is alive`,
      since,
      ...(idleMinutes === undefined ? {} : { idleMinutes }),
      subject: `${orphanFleetKey(view.id)}|assignee:${assignee}`,
    });
  }
  return anomalies;
}

// ── Escalation ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Whom the Warden told about one orphaned card, this episode:
 *
 * - `owner`: a message to the owner ferret `to`;
 * - `list`: the card is a row of the ONE machine item (`to` is that board);
 * - `notice`: a per-card ask on the board of ferret `to`, as an earlier Warden raised. Never made now: the next sweep
 *   closes it ({@link OrphanPlan.resolve}) and forgets it.
 */
export interface OrphanTold {
  /** The finished ferret the card was left by: the episode. */
  readonly assignee: string;
  readonly via: 'owner' | 'list' | 'notice';
  /** The owner ferret messaged, the machine board, or the session whose board holds a per-card ask. */
  readonly to: string;
  readonly at: string;
}

/** A card remembered as a row of the machine item, from `at`. */
export const orphanListed = (assignee: string, at: string): OrphanTold => ({
  assignee,
  via: 'list',
  to: MACHINE_AGENDA_ID,
  at,
});

/** Every orphaned card the Warden has told somebody about, keyed by card id. */
export type OrphanMemory = Readonly<Record<string, OrphanTold>>;

/** One card as a row of the machine item: its id, the ferret that left it, the one line that names it, and since when it has waited. */
export interface OrphanedCard {
  readonly id: CardId;
  /** The finished ferret the card was left by: the episode. */
  readonly assignee: string;
  readonly line: string;
  readonly waitingSince: string;
}

/** A message to the owner ferret, and the row the card becomes when the message cannot be typed. */
interface OrphanMessage {
  readonly taskId: CardId;
  readonly assignee: string;
  readonly sessionId: string;
  readonly message: string;
  /**
   * The row to list instead when the message cannot be typed. A message that did not land was not remembered, so every
   * sweep typed it again: nine messages every two minutes, each refused by the same composer, crowding out the owner's
   * own message to that ferret.
   */
  readonly fallback: OrphanedCard;
}

/** A per-card ask an earlier Warden raised, to close: its card is no longer orphaned, or is listed now. */
export interface OrphanResolution {
  readonly taskId: CardId;
  readonly sessionId: string;
  readonly sourceRef: string;
  readonly note: string;
}

export interface OrphanPlan {
  /** The messages to type to live owner ferrets. */
  readonly tell: readonly OrphanMessage[];
  /** The cards listed on the machine item without any message: no live owner ferret can be told. */
  readonly list: readonly OrphanedCard[];
  /** The per-card asks still on ferret boards from before the list: each is closed, once. */
  readonly resolve: readonly OrphanResolution[];
  /** The memory to keep, before any message is recorded as landed. */
  readonly memory: OrphanMemory;
}

export interface OrphanPlanInput {
  /** This sweep's `orphaned_card` anomalies. */
  readonly orphans: readonly WardenAnomaly[];
  readonly board: WardenBoardRead;
  /** Every session this daemon holds, live and finished. */
  readonly fleet: readonly WardenSessionView[];
  readonly memory: OrphanMemory;
  /** Whether the Warden is on: off, nobody is told, but a card that recovered is still cleared. */
  readonly enabled: boolean;
  /** The CLI a ferret or a person actually types. */
  readonly clientName: string;
}

const flatten = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

/** The ways out of an orphaned card, as commands. */
const remedies = (view: CardView, assignee: string, cli: string): string =>
  `Resume its ferret (\`${cli} resume ${assignee}\`), hand the card to another ferret (\`${cli} task assign ${view.id} <ferret>\`), or drop it (\`${cli} task drop ${view.id} --reason "<why>"\`).`;

/** What became of a ferret, for a reader who is not an engineer: it finished, failed, or is gone. */
const endedWords = (sessionId: string, fleet: ReadonlyMap<string, WardenSessionView>): string => {
  const session = fleet.get(sessionId);
  if (session === undefined) return 'is no longer on this machine';
  return session.state.status === 'failed' ? 'has failed' : 'has finished';
};

const CARD_LINE_TAIL = (lane: string): string =>
  ` is waiting in ${lane}, but no ferret is assigned, so nothing will happen to it.`;

/**
 * The one line that names an orphaned card: its reference, title and lane, and what that means. It is a row of the
 * machine item, so it has to fit a push body: a long title gives way, never the ending.
 */
function orphanCardLine(view: CardView, board: WardenBoardRead): string {
  const ref = formatCardRef(view);
  const tail = CARD_LINE_TAIL(laneName(board, view));
  const room = Math.max(24, AGENDA_PUSH_BODY_LENGTH - ref.length - 1 - tail.length);
  return flatten(`${ref} ${clipAtWord(flatten(view.title), room)}${tail}`);
}

/** The queued message to the card's owner ferret. */
function orphanOwnerMessage(
  view: CardView,
  board: WardenBoardRead,
  fleet: ReadonlyMap<string, WardenSessionView>,
  cli: string,
): string {
  const assignee = effectiveAssignee(view);
  return (
    `Your card ${formatCardRef(view)} "${flatten(view.title)}" has no ferret working on it. It is waiting in ${laneName(board, view)}, ` +
    `but its ferret ${ferretRef(assignee, fleet)} ${endedWords(assignee, fleet)}, so nothing will happen to it. ` +
    `You own the card, so pick it up: ${remedies(view, assignee, cli)}`
  );
}

/** The title of the machine item: one card, or how many. */
export const orphanTitle = (count: number): string =>
  count === 1 ? 'A card has nobody working on it' : `${String(count)} cards have nobody working on them`;

/** A card as a row of the machine item. */
const orphanedCard = (view: CardView, board: WardenBoardRead, assignee: string, since: string): OrphanedCard => ({
  id: view.id,
  assignee,
  line: orphanCardLine(view, board),
  waitingSince: since,
});

/**
 * Whom to tell about each orphaned card this sweep, which cards the machine item lists, which per-card asks to
 * close, and what to remember. Deterministic: the same inputs give the same plan in the same order.
 */
export function planOrphanEscalations(input: OrphanPlanInput): OrphanPlan {
  const fleet = new Map(input.fleet.map(session => [session.config.id, session]));
  const views = new Map(input.board.views.map(view => [view.id, view]));
  const alive = (sessionId: string): boolean => {
    const session = fleet.get(sessionId);
    return session !== undefined && !isTerminalStatus(session.state.status);
  };
  const tell: OrphanMessage[] = [];
  const list: OrphanedCard[] = [];
  const resolve: OrphanResolution[] = [];
  const memory: Record<string, OrphanTold> = {};
  const closeAsk = (taskId: CardId, told: OrphanTold, note: string): void => {
    if (told.via === 'notice') resolve.push({ taskId, sessionId: told.to, sourceRef: orphanCardAskRef(taskId), note });
  };
  // A card that was on the list already stays remembered. A card joining it now is NOT remembered here: it is
  // remembered once the item that names it has landed (`WardenSweepService.escalateOrphans`), so a refused item
  // names it again, as news, next sweep.
  const listed = (card: OrphanedCard, kept?: OrphanTold): void => {
    list.push(card);
    if (kept !== undefined) memory[card.id] = kept;
  };

  const current = new Set<string>();
  for (const anomaly of input.orphans) {
    const view = anomaly.task === undefined ? undefined : views.get(anomaly.task.id);
    if (view === undefined) continue;
    current.add(view.id);
    const assignee = anomaly.sessionId;
    const told = input.memory[view.id];
    const sameEpisode = told?.assignee === assignee;
    const card = orphanedCard(view, input.board, assignee, anomaly.since ?? view.createdAt);
    if (told !== undefined && !sameEpisode)
      closeAsk(view.id, told, 'Closed by the Warden: the card changed hands since.');
    if (sameEpisode && told.via === 'notice') {
      // Already told by a per-card ask: it becomes a row of the list, news there, and the ask is closed.
      closeAsk(view.id, told, 'Closed by the Warden: the orphaned cards are one item on the machine agenda now.');
      listed(card);
      continue;
    }
    if (sameEpisode && told.via === 'list') {
      listed(card, told);
      continue;
    }
    const ownerAlive = view.owner !== assignee && alive(view.owner);
    if (sameEpisode && ownerAlive) {
      memory[view.id] = told;
      continue;
    }
    // Not told yet this episode, or told an owner ferret that has finished since: the owner is next.
    if (!input.enabled) {
      if (sameEpisode) memory[view.id] = told;
      continue;
    }
    // An INTERACTIVE owner is the owner's own chat: a notice typed into it lands in the middle of their
    // conversation (or sits unsent in its composer, ahead of what they type). It goes on the list instead.
    const ownerChat = ownerAlive && fleet.get(view.owner)?.config.mode === 'interactive';
    if (ownerAlive && !ownerChat) {
      tell.push({
        taskId: view.id,
        assignee,
        sessionId: view.owner,
        message: orphanOwnerMessage(view, input.board, fleet, input.clientName),
        fallback: card,
      });
      continue;
    }
    listed(card);
  }

  for (const [taskId, told] of Object.entries(input.memory))
    if (!current.has(taskId))
      closeAsk(taskId, told, 'Closed by the Warden: a ferret is on the card again, or it left its lane.');

  return { tell, list, resolve, memory };
}
