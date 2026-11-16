import type { Harness } from '../protocol/session-base.ts';
import type { SessionId } from '../session-id.ts';

/**
 * The pieces of OTHER plugins a move leans on, as the smallest structural ports Ferrets (core) can name (§2.1: core
 * imports no plugin): the transcript reader (Conversation) and the host's signalling. Each is described by exactly the
 * calls a move makes. The host binds each to its owner; an unbound one is a fail-closed skeleton that refuses the move
 * before anything is written (the module lists them in `SessionMoveNeeds`).
 *
 * What a same-harness move once needed of the harnesses (where a transcript lives, the rollout index, the converter, the
 * version gate, the persisted effort, the context window) is gone: a ferret's harness home is the FERRET's, so its
 * conversation never moves, and what the target serves is Runtimes' `catalog?`.
 */

// ─── the transcript the session is bound to ─────────────────────────────────────────────────────────────────────────

/**
 * The session's own transcript, which the preflight joins its open tool ids against (today's `SessionTranscriptReader`).
 *
 * Until a session recorded its transcript this was an EMPTY array and every open tool was classified `unknown`, which
 * the gate refuses on; with provenance persisted the join has real evidence, and a session with no locatable
 * transcript degrades to exactly the previous behaviour rather than to a guess.
 */
export interface MoveTranscriptTail {
  tail(request: { readonly sessionId: SessionId; readonly harness: Harness }): Promise<readonly unknown[]>;
}

// ─── the host ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The signal a stopped job is sent. */
type ProcessStopSignal = 'SIGTERM' | 'SIGKILL';

/**
 * Signalling a process, and which processes are never signalled. The kernel hands a plugin no way to signal a pid it
 * did not start, so this is the host's: one signal to one pid, answering whether it was delivered.
 */
export interface ProcessSignalPort {
  /** Whether the signal was delivered; a process already gone, or one this daemon may not signal, is `false`. */
  signal(pid: number, signal: ProcessStopSignal): boolean;
  /** Never these, whatever a pane's tree claims: init, this daemon, and what started it. */
  protectedPids(): ReadonlySet<number>;
}
