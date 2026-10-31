/**
 * "LAST TOUCHED" AND THE ACTIVITY STATE (`board-design.md` §3.3), derived at read time from session
 * liveness and the cards, never stored.
 *
 * - **Attribution.** A session's liveness touches exactly one card: its `config.focusTask`. A lead with
 *   forty cards touches only the one it is on.
 * - **Signals** are read, never detected: a session's strong life-signs (`lastTokenAdvanceAt`,
 *   `lastTranscriptAt`, `lastSubprocessAt`/`subprocessSince`, `lastActivityAt`) after the Warden's
 *   liveness ledger is laid over them; every history event on the card; and a linked PR's merge. A pane
 *   redraw or a config write alone is never activity, the way the Warden reasons (`warden/detect.ts`).
 * - **Roll-up.** `lastTouchedAt(card)` is the latest of its own signals and every live descendant's
 *   `lastTouchedAt`, so a sub-ferret's work makes its lead's card active.
 * - **States**, first match wins: `active` → `orphaned` → `waiting` → `stale` → `idle`. A closed or
 *   dropped card is `idle`: nobody's clock runs on it.
 *
 * One roster read serves a whole board read: everything below is a pure function of it.
 */
import {
  type BoardTask,
  type BoardTaskId,
  type Lane,
  type LaneCategory,
  laneOf,
  type SessionStatus,
  type SessionTurnState,
  type StaleAfter,
  staleAfterMinutes,
  type TaskRef,
} from '@ferretry/protocol';
import { isTerminalStatus } from '../warden/types.ts';
import { effectiveAssignee } from './authority.ts';
import { blockedBy, cardCategory } from './graph.ts';
import type { ActivityDeriver, ActivityInputs, BoardClock, CardActivity } from './ports.ts';

/** A strong signal this recent makes its card `active` even between turns. */
export const ACTIVE_WINDOW_MS = 2 * 60_000;

/**
 * How long a lane's cards may sit untouched when the lane names no `staleAfter`. `null` is never: a
 * `verify` lane is the owner's clock and a `closed` one is finished.
 */
const DEFAULT_STALE_AFTER: Readonly<Record<LaneCategory, StaleAfter | null>> = {
  backlog: '3d',
  active: '2h',
  review: '24h',
  shipped: '3d',
  verify: null,
  closed: null,
};

/** One session as the board reads it. Every instant is the later of its documents and the Warden's ledger. */
export interface SessionLiveness {
  readonly id: string;
  readonly status: SessionStatus;
  readonly turnState?: SessionTurnState;
  /** The card its activity is attributed to (`config.focusTask`). */
  readonly focusTask: TaskRef | null;
  /** It declared a wait (`fy signal waiting`): it is parked on purpose and must not be nudged. */
  readonly declaredWait: boolean;
  readonly lastTokenAdvanceAt?: string;
  readonly lastTranscriptAt?: string;
  readonly lastSubprocessAt?: string;
  /** Open while a tool command runs under its pane. */
  readonly subprocessSince?: string;
  readonly lastActivityAt?: string;
}

/** Every session this daemon holds, read once. A held session missing from `sessions` could not be read. */
export interface SessionRoster {
  readonly held: ReadonlySet<string>;
  readonly sessions: ReadonlyMap<string, SessionLiveness>;
}

/** The sessions, as one read. The board's only liveness IO. */
export interface SessionLivenessSource {
  roster(): Promise<SessionRoster>;
}

/** Whether a session is there to do work: `dead` is gone or finished; `unknown` could not be read. */
export type SessionPresence = 'alive' | 'dead' | 'unknown';

export const presenceOf = (roster: SessionRoster, sessionId: string): SessionPresence => {
  if (!roster.held.has(sessionId)) return 'dead';
  const session = roster.sessions.get(sessionId);
  if (session === undefined) return 'unknown';
  return isTerminalStatus(session.status) ? 'dead' : 'alive';
};

/** Thinking, or running a tool, right now. */
export const isWorking = (session: SessionLiveness): boolean =>
  !isTerminalStatus(session.status) &&
  (session.status === 'thinking' ||
    session.status === 'tool_running' ||
    session.turnState === 'working' ||
    session.subprocessSince !== undefined);

const instant = (value: string | undefined): number => (value === undefined ? Number.NaN : Date.parse(value));

/** A session's latest strong life-sign, or `undefined` when it has none. */
export const strongSignalAt = (session: SessionLiveness): string | undefined => {
  let latest: string | undefined;
  for (const value of [
    session.lastTokenAdvanceAt,
    session.lastTranscriptAt,
    session.lastSubprocessAt,
    session.subprocessSince,
    session.lastActivityAt,
  ]) {
    if (Number.isFinite(instant(value)) && (latest === undefined || instant(value) > instant(latest))) latest = value;
  }
  return latest;
};

/**
 * How long a lane's cards may sit untouched, in milliseconds; `null` is never. A lane's own `staleAfter`
 * wins. A shipped lane a release moves cards into waits for this machine to run that release, which no
 * ferret can hurry, so it is never stale unless it says otherwise.
 */
export const staleAfterMsOf = (lane: Lane): number | null => {
  if (lane.staleAfter !== undefined) return staleAfterMinutes(lane.staleAfter) * 60_000;
  if (lane.category === 'shipped' && lane.enterOn?.includes('release.published') === true) return null;
  const fallback = DEFAULT_STALE_AFTER[lane.category];
  return fallback === null ? null : staleAfterMinutes(fallback) * 60_000;
};

/** The stale threshold of the lane a card sits in; `null` when it is never stale or its lanes are unknown. */
export const cardStaleAfterMs = (card: BoardTask, inputs: Pick<ActivityInputs, 'laneSets'>): number | null => {
  const laneSet = inputs.laneSets.get(card.projectId);
  if (laneSet === undefined) return null;
  const lane = laneOf(laneSet, card.laneId);
  return lane.ok ? staleAfterMsOf(lane.value) : null;
};

interface Touch {
  readonly at: string;
  readonly by: string | null;
}

const latest = (left: Touch | null, right: Touch | null): Touch | null => {
  if (left === null) return right;
  if (right === null) return left;
  return instant(right.at) > instant(left.at) ? right : left;
};

/** The card's own touch: its history, its merged PRs and the sessions focused on it. */
const ownTouch = (card: BoardTask, focused: readonly SessionLiveness[]): Touch | null => {
  let touch: Touch | null = null;
  for (const event of card.history) touch = latest(touch, { at: event.at, by: event.actor.sessionId ?? null });
  for (const pr of card.links.prs) if (pr.mergedAt !== null) touch = latest(touch, { at: pr.mergedAt, by: null });
  for (const session of focused) {
    const at = strongSignalAt(session);
    if (at !== undefined) touch = latest(touch, { at, by: session.id });
  }
  return touch;
};

interface Walked {
  readonly touch: Touch | null;
  readonly active: boolean;
  /** This card's ferret, or a descendant's, is alive (or could not be read, so is not called dead). */
  readonly live: boolean;
}

/**
 * Every card's activity from one roster. Linear in cards plus sessions: each card is walked once and its
 * result memoized. A loop in `parent` (a damaged board) is cut where it closes, and what was walked
 * through a cut is not memoized, so every card on the loop still sees the whole loop.
 */
export const deriveActivities = (
  inputs: ActivityInputs,
  roster: SessionRoster,
  nowMs: number,
): ReadonlyMap<BoardTaskId, CardActivity> => {
  const focused = new Map<BoardTaskId, SessionLiveness[]>();
  for (const session of roster.sessions.values()) {
    const ref = session.focusTask;
    if (ref === null || !inputs.index.isLocal(ref)) continue;
    const list = focused.get(ref.id);
    if (list === undefined) focused.set(ref.id, [session]);
    else list.push(session);
  }

  const walked = new Map<BoardTaskId, Walked>();
  const walking = new Set<BoardTaskId>();
  let cut = false;
  const walk = (card: BoardTask): Walked => {
    const done = walked.get(card.id);
    if (done !== undefined) return done;
    if (walking.has(card.id)) {
      cut = true;
      return { touch: null, active: false, live: false };
    }
    const outer = cut;
    cut = false;
    walking.add(card.id);
    const sessions = focused.get(card.id) ?? [];
    let touch = ownTouch(card, sessions);
    let active = sessions.some(
      session => isWorking(session) || nowMs - instant(strongSignalAt(session)) <= ACTIVE_WINDOW_MS,
    );
    // An UNASSIGNED card still in the backlog is nobody's work yet: it falls to its owner only as a default,
    // so the owner being alive keeps nothing under a parent alive. Counted, a lead's live session hid every
    // card whose ferret had finished behind one Todo child it had not handed out (&F240, 2026-10-31).
    const unclaimed = card.assignee === null && cardCategory(card, inputs.laneSets) === 'backlog';
    let live = !unclaimed && presenceOf(roster, effectiveAssignee(card)) !== 'dead';
    for (const child of inputs.index.children(card.id)) {
      if (child.dropped !== null) continue;
      const below = walk(child);
      touch = latest(touch, below.touch);
      active ||= below.active;
      live ||= below.live;
    }
    const result = { touch, active, live };
    walking.delete(card.id);
    if (!cut) walked.set(card.id, result);
    cut ||= outer;
    return result;
  };

  const activities = new Map<BoardTaskId, CardActivity>();
  for (const card of inputs.cards) {
    const { touch, active } = walk(card);
    activities.set(card.id, {
      lastTouchedAt: touch?.at ?? null,
      touchedBy: touch?.by ?? null,
      activity: stateOf(card, { touch, active }, inputs, roster, nowMs, walk),
    });
  }
  return activities;
};

const stateOf = (
  card: BoardTask,
  own: Pick<Walked, 'touch' | 'active'>,
  inputs: ActivityInputs,
  roster: SessionRoster,
  nowMs: number,
  walk: (card: BoardTask) => Walked,
): CardActivity['activity'] => {
  const category = cardCategory(card, inputs.laneSets);
  if (card.dropped !== null || category === 'closed') return 'idle';
  if (own.active) return 'active';
  if (
    (category === 'active' || category === 'review') &&
    presenceOf(roster, effectiveAssignee(card)) === 'dead' &&
    !inputs.index.children(card.id).some(child => child.dropped === null && walk(child).live)
  ) {
    return 'orphaned';
  }
  const asks = inputs.asks.get(card.id);
  if (
    card.blocked !== null ||
    (asks !== undefined && asks.blocking.length > 0) ||
    blockedBy(card, inputs.index, inputs.laneSets).length > 0
  ) {
    return 'waiting';
  }
  const staleAfter = cardStaleAfterMs(card, inputs);
  const since = instant(own.touch?.at ?? card.createdAt);
  if (staleAfter !== null && nowMs - since > staleAfter) return 'stale';
  return 'idle';
};

/** The activity deriver over the sessions this daemon holds: one roster read per board read. */
export class LivenessActivityDeriver implements ActivityDeriver {
  constructor(private readonly ports: { readonly sessions: SessionLivenessSource; readonly clock: BoardClock }) {}

  async derive(inputs: ActivityInputs): Promise<ReadonlyMap<BoardTaskId, CardActivity>> {
    return deriveActivities(inputs, await this.ports.sessions.roster(), Date.parse(this.ports.clock.now()));
  }
}
