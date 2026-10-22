/**
 * THE SESSION-WORKER PROTOCOL: every message between the main thread and a session worker.
 *
 * A closed, hand-typed union with an exhaustive `switch` on both sides — no zod, no value import of
 * `@ferretry/protocol` — because the worker must stay lean (`docs/design/session-workers.md` §3.4). Every
 * session message names the session and the GENERATION it is addressed to: a worker restarted, or a
 * session moved between workers, is a new generation, and anything still in flight for the old one is
 * ignored.
 *
 * DIFFS, NEVER DERIVED EVENTS. A reply carries a patch for the one writer on the main thread; the
 * transcript, the frames and the parsed events stay in the worker (§2.3).
 *
 * Stage 3b runs the TURN part in workers; the question facts and the answer rows already travel so that
 * stage 3c can move the question part without changing the protocol's shape.
 */
import type { AnswerOperationRecord } from '../question/answer-ledger.ts';
import type { ObserverFacts } from './facts.ts';
import type { TurnPatch } from './observer.ts';

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
  /** Look at the session now and answer with the turn change it implies, if any. */
  | { readonly kind: 'look'; readonly session: string; readonly generation: number; readonly request: number }
  | { readonly kind: 'detach'; readonly session: string; readonly generation: number };

export type FromSessionWorker =
  | WorkerProbe
  | {
      readonly kind: 'looked';
      readonly session: string;
      readonly generation: number;
      readonly request: number;
      /** The change for the writer to compare-and-set; absent when the look implied none. */
      readonly patch?: TurnPatch | undefined;
      /** Why the look could not be made; the main thread looks once itself instead. */
      readonly failure?: string | undefined;
      readonly lookMs: number;
      readonly metrics: WorkerMetrics;
    }
  /** Something went wrong outside a look; `fatal` ends the worker and restarts what it hosted. */
  | {
      readonly kind: 'fault';
      readonly session?: string | undefined;
      readonly message: string;
      readonly fatal: boolean;
    };
