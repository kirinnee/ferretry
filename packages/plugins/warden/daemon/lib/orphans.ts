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
 * 2. otherwise the owner (the person) gets a plain notice tied to the card (`task` on the agenda item),
 *    on the board of the card's owner ferret, else of its finished assignee.
 *
 * Once per EPISODE: one card left by one ferret. The Warden remembers whom it told
 * ({@link OrphanMemory}); a card still orphaned is not told again, except that a message to an owner
 * ferret that has since finished too moves on to the notice. A card that is no longer orphaned is
 * forgotten, and its notice cleared: when it is orphaned again it is news again.
 *
 * Pure: the board, the fleet and the memory arrive through the arguments.
 */
import { type CardId, type CardRef, type CardView, formatCardRef, type LaneSet } from '@ferretry/plugin-board/contract';
import {
  AGENDA_PUSH_BODY_LENGTH,
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_REASON_LENGTH,
} from './protocol.ts';
import { inWardenLineage, type WardenAnomaly } from './detect.ts';
import { wardenTeammateToken } from './prompt.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** Every board's lanes, by project id. */
export type LaneSets = ReadonlyMap<string, LaneSet>;

/** Every card as the board derives it, with every board's lanes: one read per sweep. */
export interface WardenBoardRead {
  readonly views: readonly CardView[];
  readonly laneSets: LaneSets;
}

/** The card's working ferret: the assignee, else the owner (Board's rule: a `null` assignee reads as the owner). */
const effectiveAssignee = (card: Pick<CardView, 'owner' | 'assignee'>): string => card.assignee ?? card.owner;

/** The anomaly identity of an orphaned card: about the card, so two cards one ferret left are two flags. */
export const orphanFleetKey = (id: CardId): string => `card:${id}`;

/** The source reference of a card's orphan notice: its dedupe key on the board it is raised on. */
export const orphanNoticeSourceRef = (id: CardId): string => `warden-orphan:${id}`;

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

/** Whom the Warden told about one orphaned card, this episode. */
export interface OrphanTold {
  /** The finished ferret the card was left by: the episode. */
  readonly assignee: string;
  readonly via: 'owner' | 'notice';
  /** The owner ferret messaged, or the session whose board holds the notice. */
  readonly to: string;
  readonly at: string;
}

/** Every orphaned card the Warden has told somebody about, keyed by card id. */
export type OrphanMemory = Readonly<Record<string, OrphanTold>>;

/** A plain notice to the owner, tied to a card. */
export interface WardenCardNotice {
  readonly sourceRef: string;
  readonly task: CardRef;
  readonly title: string;
  readonly subject: string;
  readonly why: string;
  readonly premise: string;
  readonly context: string;
  readonly howToResolve: string;
  readonly waitingSince: string;
}

export type OrphanTell =
  | {
      readonly kind: 'message';
      readonly taskId: CardId;
      readonly assignee: string;
      readonly sessionId: string;
      readonly message: string;
      /**
       * Put on the same ferret's board instead when the message cannot be typed. A message that did not
       * land was not remembered, so every sweep typed it again: nine notices every two minutes, each
       * refused by the same composer, crowding out the owner's own message to that ferret.
       */
      readonly fallback: WardenCardNotice;
    }
  | {
      readonly kind: 'notice';
      readonly taskId: CardId;
      readonly assignee: string;
      readonly sessionId: string;
      readonly notice: WardenCardNotice;
    };

/** A notice whose card is no longer orphaned in the episode it was about. */
export interface OrphanResolution {
  readonly taskId: CardId;
  readonly sessionId: string;
  readonly sourceRef: string;
  readonly note: string;
}

export interface OrphanPlan {
  readonly tell: readonly OrphanTell[];
  readonly resolve: readonly OrphanResolution[];
  /** Orphaned cards nobody can be told about: no board on this machine to hold a notice. */
  readonly unreported: readonly CardId[];
  /** The memory to keep, before any tell is recorded as landed. */
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
  /** This machine's name, so a notice read among every machine's says which one. */
  readonly machine?: string;
}

const flatten = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

/** Fit a field to what the agenda accepts: a refusal at the write is a lost notice. */
const clamp = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;

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
 * The one line that names an orphaned card: its reference, title and lane, and what that means. It is what the
 * notice's subject and the machine list's row say, so it has to fit a push body: a long title gives way, never
 * the ending.
 */
export function orphanCardLine(view: CardView, board: WardenBoardRead): string {
  const ref = formatCardRef(view);
  const tail = CARD_LINE_TAIL(laneName(board, view));
  const room = Math.max(24, AGENDA_PUSH_BODY_LENGTH - ref.length - 1 - tail.length);
  return flatten(`${ref} ${clipAtWord(flatten(view.title), room)}${tail}`);
}

/** The queued message to the card's owner ferret. */
export function orphanOwnerMessage(
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

/** The notice's title: one card, or how many. */
export const orphanTitle = (count: number): string =>
  count === 1 ? 'A card has nobody working on it' : `${String(count)} cards have nobody working on them`;

/** The notice to the owner, when no ferret that owns the card is alive to be told. */
export function orphanNotice(
  view: CardView,
  board: WardenBoardRead,
  fleet: ReadonlyMap<string, WardenSessionView>,
  input: Pick<OrphanPlanInput, 'clientName' | 'machine'>,
  since: string,
): WardenCardNotice {
  const ref = formatCardRef(view);
  const assignee = effectiveAssignee(view);
  const lane = laneName(board, view);
  const where = input.machine === undefined ? '' : ` on ${input.machine}`;
  const owner =
    view.owner === assignee
      ? 'It is the only ferret that answers for the card.'
      : `The ferret that owns the card, ${ferretRef(view.owner, fleet)}, ${endedWords(view.owner, fleet)} too.`;
  return {
    sourceRef: orphanNoticeSourceRef(view.id),
    task: { id: view.id },
    title: clamp(orphanTitle(1), AGENDA_PUSH_TITLE_LENGTH),
    subject: clamp(orphanCardLine(view, board), AGENDA_PUSH_BODY_LENGTH),
    why: clamp(
      flatten(
        `The last ferret on it, ${ferretRef(assignee, fleet)}, ${endedWords(assignee, fleet)}. ${owner} A card only moves when a ferret works on it, so this one will sit in ${lane} until you act.`,
      ),
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    premise: clamp(
      `- Card: ${ref} ${flatten(view.title)}${where}, waiting in ${lane}.\n- Last ferret on it: ${ferretRef(assignee, fleet)}.`,
      MAX_AGENDA_REASON_LENGTH,
    ),
    context: clamp(`- ${lane} is a lane where a ferret should be working the card. None is.`, MAX_AGENDA_DETAIL_LENGTH),
    howToResolve: clamp(
      `Open ${ref} to see where it stands. Then start a ferret on it to carry on, or close the card if it is no longer needed.\nThis notice clears itself once a ferret is on the card again.`,
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    waitingSince: since,
  };
}

/**
 * Whom to tell about each orphaned card this sweep, which notices to clear, and what to remember.
 * Deterministic: the same inputs give the same plan in the same order.
 */
export function planOrphanEscalations(input: OrphanPlanInput): OrphanPlan {
  const fleet = new Map(input.fleet.map(session => [session.config.id, session]));
  const views = new Map(input.board.views.map(view => [view.id, view]));
  const alive = (sessionId: string): boolean => {
    const session = fleet.get(sessionId);
    return session !== undefined && !isTerminalStatus(session.state.status);
  };
  const tell: OrphanTell[] = [];
  const resolve: OrphanResolution[] = [];
  const unreported: CardId[] = [];
  const memory: Record<string, OrphanTold> = {};
  const clear = (taskId: CardId, told: OrphanTold, note: string): void => {
    if (told.via === 'notice')
      resolve.push({ taskId, sessionId: told.to, sourceRef: orphanNoticeSourceRef(taskId), note });
  };

  const current = new Set<string>();
  for (const anomaly of input.orphans) {
    const view = anomaly.task === undefined ? undefined : views.get(anomaly.task.id);
    if (view === undefined) continue;
    current.add(view.id);
    const assignee = anomaly.sessionId;
    const told = input.memory[view.id];
    const sameEpisode = told?.assignee === assignee;
    if (told !== undefined && !sameEpisode)
      clear(view.id, told, 'Cleared by the Warden: the card changed hands since.');
    const ownerAlive = view.owner !== assignee && alive(view.owner);
    // An INTERACTIVE owner is the owner's own chat: a notice typed into it lands in the middle of their
    // conversation (or sits unsent in its composer, ahead of what they type). It goes on its board instead.
    const ownerChat = ownerAlive && fleet.get(view.owner)?.config.mode === 'interactive';
    if (sameEpisode && (told.via === 'notice' || ownerAlive)) {
      memory[view.id] = told;
      continue;
    }
    // Not told yet this episode, or told an owner ferret that has finished since: the owner is next.
    if (!input.enabled) {
      if (sameEpisode) memory[view.id] = told;
      continue;
    }
    const notice = orphanNotice(view, input.board, fleet, input, anomaly.since ?? view.createdAt);
    if (ownerChat) {
      tell.push({ kind: 'notice', taskId: view.id, assignee, sessionId: view.owner, notice });
      continue;
    }
    if (ownerAlive) {
      tell.push({
        kind: 'message',
        taskId: view.id,
        assignee,
        sessionId: view.owner,
        message: orphanOwnerMessage(view, input.board, fleet, input.clientName),
        fallback: notice,
      });
      continue;
    }
    const home = [view.owner, assignee].find(sessionId => fleet.has(sessionId));
    if (home === undefined) {
      unreported.push(view.id);
      continue;
    }
    tell.push({ kind: 'notice', taskId: view.id, assignee, sessionId: home, notice });
  }

  for (const [taskId, told] of Object.entries(input.memory))
    if (!current.has(taskId))
      clear(taskId, told, 'Cleared by the Warden: a ferret is on the card again, or it left its lane.');

  return { tell, resolve, unreported, memory };
}
