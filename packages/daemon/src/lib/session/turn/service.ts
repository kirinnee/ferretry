import type { HarnessDialog, PermissionRequest, SessionState, SessionTurnState } from '@ferretry/protocol';
import type { ClockPort } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { TranscriptEvent } from '../../transcript/types.ts';
import {
  isTurnStatus,
  observeTurn,
  settleHarnessDialog,
  settlePermissionRequest,
  settleTurnPrompt,
  settleTurnState,
  type TurnObservation,
  type TurnPaneEvidence,
  transcriptTurnPhase,
} from './policy.ts';

/** How often the watcher looks: often enough that a finished turn reads as finished within seconds. */
export const TURN_WATCH_INTERVAL_MS = 2_000;

/** One session as the watcher needs it. */
export interface TurnWatchSession {
  readonly id: SessionId;
  readonly state: Pick<
    SessionState,
    'status' | 'turn' | 'pendingQuestion' | 'turnState' | 'turnPrompt' | 'permissionRequest' | 'harnessDialog'
  >;
}

/** A recorded change, as the journal and the event stream carry it. */
export interface TurnStateChange {
  readonly from: SessionTurnState | undefined;
  readonly to: SessionTurnState | undefined;
  /** The harness dialog behind `to`, recorded as `turnPrompt`; absent clears it. */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt behind `to`, recorded as `permissionRequest`; absent clears it. */
  readonly request?: PermissionRequest | undefined;
  /** The harness's own dialog behind `to`, recorded as `harnessDialog`; absent clears it. */
  readonly dialog?: HarnessDialog | undefined;
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
 * THE ONE OWNER OF `turnState`.
 *
 * Every live session is looked at on every tick: one local terminal capture and one transcript tail
 * read each — nothing that starts a turn or spends a token. A session that is not live has its
 * record cleared and is not read at all.
 *
 * The previous observation per session is the only state held in memory, and only for the
 * two-frame confirmation `settleTurnState` asks for. Losing it on a restart costs one extra tick
 * before an unconfirmed `your-turn` is recorded — never a wrong answer, because everything else is
 * re-derived from evidence that outlives the daemon.
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
    await Promise.all(
      sessions.map(async session => {
        try {
          const change = await this.watch(session);
          if (change !== undefined) changed.set(session.id, change);
        } catch (error) {
          failures.set(session.id, message(error));
        }
      }),
    );
    const roster = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!roster.has(id)) this.previous.delete(id);
    return { changed, failures };
  }

  private async watch(session: TurnWatchSession): Promise<TurnStateChange | undefined> {
    const live = isTurnStatus(session.state.status);
    let observation: TurnObservation | undefined;
    if (live) {
      const [events, pane] = await Promise.all([this.ports.transcript(session.id), this.ports.pane(session.id)]);
      observation = observeTurn({
        state: session.state,
        transcript: events === undefined ? 'unknown' : transcriptTurnPhase(events),
        pane,
      });
    }
    const next = settleTurnState(session.state.turnState, observation, this.previous.get(session.id), live);
    const prompt = settleTurnPrompt(session.state.turnPrompt, next, observation);
    const request = settlePermissionRequest(session.state.permissionRequest, next, observation);
    const dialog = settleHarnessDialog(session.state.harnessDialog, next, observation);
    this.previous.set(session.id, observation);
    // A request or a dialog is compared by its id, a digest of everything a person decides on: somebody
    // at the terminal moving the cursor between rows is not a new one and records nothing.
    if (
      next === session.state.turnState &&
      prompt === session.state.turnPrompt &&
      request?.id === session.state.permissionRequest?.id &&
      dialog?.id === session.state.harnessDialog?.id
    )
      return undefined;
    const change = {
      from: session.state.turnState,
      to: next,
      ...(prompt === undefined ? {} : { prompt }),
      ...(request === undefined ? {} : { request }),
      ...(dialog === undefined ? {} : { dialog }),
    };
    return (await this.ports.record(session.id, change, this.ports.clock.now())) ? change : undefined;
  }
}
