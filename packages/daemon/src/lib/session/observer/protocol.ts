/**
 * THE SESSION-WORKER PROTOCOL: every message between the main thread and a session worker.
 *
 * A closed, hand-typed union with an exhaustive `switch` on both sides — no zod, no value import of
 * `@ferretry/protocol` — because the worker must stay lean (`docs/design/session-workers.md` §3.4). Every
 * session message names the session and the GENERATION it is addressed to: a worker restarted, or a
 * session moved between workers, is a new generation, and anything still in flight for the old one is
 * ignored.
 *
 * DIFFS, NEVER DERIVED EVENTS. An `observed` message carries patches for the one writer on the main
 * thread; the transcript, the frames and the parsed events stay in the worker (§2.3).
 *
 * EVENT-DRIVEN (stage 3c). A worker looks when its session's pane drew (a tmux subscription), when the main
 * thread says the transcript changed (`file`), to confirm an unconfirmed turn end, and on a slow backstop —
 * and posts what it found unasked. The main thread asks only when it needs an answer now: a read that
 * must see what the transcript says (`observe`), the live readout's frame (`pane`), the Warden's liveness
 * look (`liveness`) and the send tracker's evidence (`send-evidence`).
 */
import type { PaneState } from '../../tmux/contracts.ts';
import type { ObservedHumanInput } from '../../transcript/types.ts';
import type { AnswerOperationRecord } from '../question/answer-ledger.ts';
import type { ObserverFacts } from './facts.ts';
import type { ObserverPatch } from './observer.ts';

/** Where one session's evidence is: its tmux session on this daemon's server, and its transcript. */
export interface SessionBinding {
  readonly tmux: {
    /** The tmux executable, absolute. */
    readonly executable: string;
    /** The daemon's private tmux socket, absolute. */
    readonly socket: string;
    /** The session's tmux session name. */
    readonly target: string;
  };
  /** The transcript proved to be this session's, once one is; absent before. */
  readonly transcript?: { readonly file: string; readonly harness: 'claude' | 'codex' } | undefined;
}

/** Which bytes of a transcript a look read: the main thread compares it with a `stat` of its own. */
export interface TranscriptStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

/** What the Warden's liveness fold needs from a worker: the screen, and a fingerprint of the tail. */
export interface WorkerLiveness {
  readonly screen?: string | undefined;
  readonly transcript?: string | undefined;
}

/** A child the worker started, as the profile counts it. */
export interface WorkerChild {
  readonly argv: readonly string[];
  readonly wallMs: number;
}

/** What a worker did since its last report: the profiler cannot see inside a worker by itself (§6.5). */
export interface WorkerMetrics {
  readonly children: readonly WorkerChild[];
}

/** The `fyd --check` probe, in the shape every bundled worker answers. */
export interface WorkerProbe {
  readonly probe: true;
}

/** What the main thread may ask a worker, and what each answers. */
export type WorkerAsk =
  /** Look now — the transcript re-checked — and post what changed before answering: a read barrier. */
  | { readonly kind: 'observe' }
  /** The pane as its worker last captured it, captured again only if it drew since. */
  | { readonly kind: 'pane' }
  /** The Warden's liveness look: the screen, and a fingerprint of the transcript's tail. */
  | { readonly kind: 'liveness' }
  /** The send tracker's transcript evidence since `since`. */
  | { readonly kind: 'send-evidence'; readonly since: string };

/** The answer to each {@link WorkerAsk}, by kind. */
export interface WorkerAnswers {
  readonly observe: null;
  readonly pane: PaneState | null;
  readonly liveness: WorkerLiveness;
  readonly 'send-evidence': {
    readonly readable: boolean;
    readonly unbound?: true;
    readonly inputs: readonly ObservedHumanInput[];
  };
}

export type ToSessionWorker =
  | WorkerProbe
  | {
      readonly kind: 'attach';
      readonly session: string;
      readonly generation: number;
      readonly facts: ObserverFacts;
      readonly binding: SessionBinding;
    }
  | { readonly kind: 'facts'; readonly session: string; readonly generation: number; readonly facts: ObserverFacts }
  | { readonly kind: 'bind'; readonly session: string; readonly generation: number; readonly binding: SessionBinding }
  | {
      readonly kind: 'answers';
      readonly session: string;
      readonly generation: number;
      readonly rows: readonly AnswerOperationRecord[];
    }
  /** The session's transcript changed (the file-event hub said so): look at it again. */
  | { readonly kind: 'file'; readonly session: string; readonly generation: number }
  | {
      readonly kind: 'request';
      readonly session: string;
      readonly generation: number;
      readonly request: number;
      readonly ask: WorkerAsk;
    }
  | { readonly kind: 'detach'; readonly session: string; readonly generation: number };

export type FromSessionWorker =
  | WorkerProbe
  /** A look found these changes, in the order they must be applied (question before turn). */
  | {
      readonly kind: 'observed';
      readonly session: string;
      readonly generation: number;
      readonly patches: readonly ObserverPatch[];
      /** The transcript bytes this look decided from; absent when it read none. */
      readonly transcript?: TranscriptStamp | undefined;
      readonly lookMs: number;
      readonly metrics: WorkerMetrics;
    }
  /** The screen or the transcript's tail changed: the Warden's liveness look, pushed instead of asked for. */
  | {
      readonly kind: 'liveness';
      readonly session: string;
      readonly generation: number;
      readonly liveness: WorkerLiveness;
    }
  | {
      readonly kind: 'answered';
      readonly session: string;
      readonly generation: number;
      readonly request: number;
      /** The answer when it could be given; `undefined` with `failure` when it could not. */
      readonly value?: unknown;
      readonly failure?: string | undefined;
      readonly metrics: WorkerMetrics;
    }
  /**
   * The session's pane died (its `#{pane_dead}` turned 1), or the worker's client has been down long enough
   * that it can no longer say the pane is alive: the main thread proves the exit, and settles it (3d).
   */
  | { readonly kind: 'exited'; readonly session: string; readonly generation: number }
  /** Something went wrong outside a look; `fatal` ends the worker and restarts what it hosted. */
  | {
      readonly kind: 'fault';
      readonly session?: string | undefined;
      readonly message: string;
      readonly fatal: boolean;
    };
