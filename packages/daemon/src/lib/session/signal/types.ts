import { SessionStatusSchema, type SessionHealth, type SessionStatus } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';

/**
 * What a session says about ITSELF, as distinct from what an operator does TO it.
 *
 * Every other write surface in the daemon is addressed by a person or by the daemon's own
 * supervision: a start, a stop, a revive, a migration. This one is addressed by the agent in the
 * pane, and that is the whole reason it exists. An automode teammate has no human at the wheel, so
 * the only account of "I finished", "I am parked", or "I am stuck" is the one it gives.
 *
 * The absence of this surface was not a missing convenience. `FileResumeTurnStore.clearMarkers`
 * already deletes `done.marker` before every revive, and nothing in the daemon ever wrote one — so
 * a session could be given work and could never report having done it, and no supervisor could tell
 * a finished teammate from a hung one.
 */

/** The four things a session may say about itself. Mirrors `SignalKindSchema` on the wire. */
export type SessionSignalKind = 'done' | 'help' | 'waiting' | 'working';

/**
 * Statuses a signal must not write over.
 *
 * The four terminal ones plus `kill_failed`: each is a verdict some other path already reached, and
 * a session's own claim must not overwrite it. Declaring a wait from one of them would suspend the
 * supervision that produced the verdict in the first place.
 *
 * `stalled` IS IN THIS SET, and the resume domain deliberately excludes it from
 * `TERMINAL_RESUME_STATUSES` — the two are answering different questions. A revive asks "is there
 * still an agent in the pane to type into", and a stalled pane usually has one. A signal asks "may
 * this session speak for itself", and a stalled session is one the reflex layer has already stopped
 * believing: letting it declare a four-hour park would be the stall hiding behind the very feature
 * that exists to distinguish parked from dead.
 */
export const PROTECTED_SIGNAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
]);

/** A wait the session declared, exactly as the state document carries it. */
export interface DeclaredWait {
  readonly since: string;
  readonly until?: string | undefined;
  readonly condition?: string | undefined;
  /** The session whose reply ends the park. Always a resolved id, never the reference given. */
  readonly peer?: string | undefined;
  readonly peerName?: string | undefined;
}

/** One session, as everything in this slice reads it. */
export interface SignalTarget {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly mode: 'auto' | 'interactive';
  /** The turn a `done` marker certifies. Read from the state document, which is the one that moves. */
  readonly turn: number;
  readonly teammate?: string | undefined;
  readonly waiting?: DeclaredWait | undefined;
  /** Seconds already credited back for time spent deliberately parked. */
  readonly waitingCreditSeconds?: number | undefined;
}

/** One durable state change a signal makes, named by the event it journals. */
export interface SignalTransition {
  readonly event:
    | 'session.completed'
    | 'session.protocol_violation'
    | 'interaction.help'
    | 'session.waiting'
    | 'session.waiting_cleared';
  readonly status?: SessionStatus | undefined;
  readonly health?: SessionHealth | undefined;
  readonly reason?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly promptReady?: boolean | undefined;
  /** The wait to record, or `clear` to drop the one on the document. */
  readonly waiting?: DeclaredWait | 'clear' | undefined;
  readonly waitingCreditSeconds?: number | undefined;
  /**
   * Re-stamps the activity ledger and drops the nudge mark.
   *
   * Leaving a park produces no life-signs by design, so waking into a ledger that is hours stale
   * would have the very next supervision tick nudge — or kill — the teammate that just came back.
   */
  readonly reanchorActivity?: boolean | undefined;
  readonly data?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/** Durable boundary for signals: reads the target and records each transition it makes. */
export interface SignalRepository {
  read(id: SessionId): Promise<SignalTarget | undefined>;
  /**
   * The session a peer reference names — an id or a teammate callsign.
   *
   * Separate from `read` because a peer arrives as a caller-supplied REFERENCE rather than an id the
   * route already parsed, and resolving it is the only thing that stops a typo becoming a park on a
   * reply that can never arrive.
   */
  resolvePeer(reference: string): Promise<SignalTarget | undefined>;
  transition(id: SessionId, change: SignalTransition): Promise<SignalTarget>;
}

/**
 * The files a signal leaves behind, which outlive the pane that wrote them.
 *
 * These are evidence rather than state: the summary is what a human reads after the agent is gone,
 * and the markers are what a supervisor reads when the daemon itself restarted.
 */
export interface SignalArtifacts {
  /** The completion summary. A teammate that gave no message still gets a file, never an absence. */
  writeSummary(id: SessionId, message: string | undefined): Promise<void>;
  /**
   * The completion marker, carrying the turn it certifies.
   *
   * THE TURN IS THE POINT. A marker from an OLDER turn must never complete a NEWER one: a later turn
   * bumps the persisted turn before it is delivered, so a daemon death in that window would
   * otherwise let stale evidence certify work that never ran.
   */
  markDone(id: SessionId, turn: number): Promise<void>;
  /** Records the question in the session's outbox and raises the needs-help marker beside it. */
  raiseQuestion(id: SessionId, message: string): Promise<void>;
}

/** The terminal side of a signal. Every address goes through the daemon's own isolated tmux socket. */
export interface SignalTerminal {
  /** Captures the final frame before the pane is retired, so the last screen survives it. */
  snapshot(id: SessionId): Promise<void>;
  /** Stops the pane this daemon created for this session, and nothing else. */
  stop(id: SessionId, reason: string): Promise<void>;
}

/** A signal the daemon declined to act on. Distinct from one that was acted on and failed. */
export class SignalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalRefused';
  }
}

/** The reference a wait named resolves to nobody, so the park could never end on a reply. */
export class UnknownPeerRefused extends SignalRefused {
  constructor(reference: string) {
    super(`unknown session ${JSON.stringify(reference)} — cannot wait for a reply from it`);
    this.name = 'UnknownPeerRefused';
  }
}

/** Statuses parse off the state document with the schema that governs it, never a guess. */
export function signalStatusOf(value: unknown): SessionStatus | undefined {
  const parsed = SessionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
