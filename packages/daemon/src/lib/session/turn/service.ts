import type { ClockPort } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { TranscriptEvent } from '../../transcript/types.ts';
import { stepTurn, type TurnFacts, type TurnLook, type TurnStateChange } from '../observer/turn.ts';
import { isTurnStatus, type TurnObservation, type TurnPaneEvidence } from './policy.ts';

export type { TurnStateChange } from '../observer/turn.ts';

/** How often the watcher looks: often enough that a finished turn reads as finished within seconds. */
export const TURN_WATCH_INTERVAL_MS = 2_000;

/** One session as the watcher needs it. */
export interface TurnWatchSession {
  readonly id: SessionId;
  readonly state: TurnFacts;
}

export interface SessionTurnPorts {
  /** Every session this daemon holds, with the fields a decision reads. */
  sessions(): Promise<readonly TurnWatchSession[]>;
  /** The transcript tail, or `undefined` when no transcript is proved to be this session's yet. */
  transcript(id: SessionId): Promise<readonly TranscriptEvent[] | undefined>;
  /** One live frame of the agent's pane, or `undefined` when there is no pane to read. */
  pane(id: SessionId): Promise<TurnPaneEvidence | undefined>;
  /**
   * Records the change under the session's own lock, re-reading the status there so a stop that
   * landed meanwhile is never overwritten, and journals it so the event stream carries it. Answers
   * whether anything was written.
   */
  record(id: SessionId, change: TurnStateChange, at: string): Promise<boolean>;
  readonly clock: ClockPort;
}

export interface TurnWatchReport {
  readonly changed: ReadonlyMap<SessionId, TurnStateChange>;
  readonly failures: ReadonlyMap<SessionId, string>;
}

/** The background loop as the composition root arms it. */
export interface TurnWatchLoop {
  readonly intervalMs: number;
  /** One tick. Never rejects: a background timer must not take the daemon down. */
  run(): Promise<TurnWatchReport | undefined>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE ONE OWNER OF `turnState` — the loop that runs the session observer's turn part on a timer.
 *
 * Every live session is looked at on every tick: one local terminal capture and one transcript tail
 * read each — nothing that starts a turn or spends a token. A session that is not live has its
 * record cleared and is not read at all.
 *
 * WHAT IT DECIDES IT DOES NOT DECIDE HERE. The decision is the session observer's turn part,
 * `stepTurn` (`lib/session/observer/turn.ts`), the pure per-session fold a worker host runs too; this
 * loop only gathers each look through its ports and records what the fold answers. The previous
 * observation per session, for the two-frame confirmation `settleTurnState` asks for, is the only
 * state held in memory. Losing it on a restart costs one extra tick before an unconfirmed `your-turn`
 * is recorded — never a wrong answer, because everything else is re-derived from evidence that
 * outlives the daemon.
 */
export class SessionTurnWatcher implements TurnWatchLoop {
  readonly intervalMs = TURN_WATCH_INTERVAL_MS;
  private readonly previous = new Map<SessionId, TurnObservation | undefined>();
  private running = false;

  constructor(private readonly ports: SessionTurnPorts) {}

  async run(): Promise<TurnWatchReport | undefined> {
    // A tick slower than the interval must not overlap the next one: two would race the same record.
    if (this.running) return undefined;
    this.running = true;
    try {
      return await this.tick();
    } catch {
      return undefined;
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<TurnWatchReport> {
    const sessions = await this.ports.sessions();
    const changed = new Map<SessionId, TurnStateChange>();
    const failures = new Map<SessionId, string>();
    // One session at a time: every live session's tail and pane capture at once was a burst of parses
    // and spawns on a large fleet, and the tick is a background watcher that nothing waits on.
    for (const session of sessions) {
      try {
        const change = await this.watch(session);
        if (change !== undefined) changed.set(session.id, change);
      } catch (error) {
        failures.set(session.id, message(error));
      }
    }
    const roster = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!roster.has(id)) this.previous.delete(id);
    return { changed, failures };
  }

  private async watch(session: TurnWatchSession): Promise<TurnStateChange | undefined> {
    let look: TurnLook | undefined;
    if (isTurnStatus(session.state.status)) {
      const [transcript, pane] = await Promise.all([this.ports.transcript(session.id), this.ports.pane(session.id)]);
      look = { transcript, pane };
    }
    const step = stepTurn(session.state, this.previous.get(session.id), look);
    this.previous.set(session.id, step.observation);
    if (step.change === undefined) return undefined;
    return (await this.ports.record(session.id, step.change, this.ports.clock.now())) ? step.change : undefined;
  }
}
