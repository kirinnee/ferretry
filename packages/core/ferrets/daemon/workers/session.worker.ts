/**
 * A SESSION WORKER: the session observer's turn part, for the sessions this thread hosts.
 *
 * Wiring only — the program is `SessionWorkerRuntime`. It holds no storage, opens no database and writes
 * no file: it reads its sessions' panes through their own attached observe-only tmux clients and their
 * transcripts from disk, and posts turn patches the main thread applies (`docs/design/session-workers.md`).
 * Kept lean on purpose — no zod, no protocol schemas, no storage, no vault — and held so by the diet test.
 *
 * WHAT FERRETS DOES NOT OWN IS HANDED IN. The session's attached control client (the terminals plugin's
 * `ControlModeTmuxProcess` over `BunTmuxProcess`, attached with `SESSION_WORKER_ATTACH_FLAGS` and subscribed to
 * `PANE_WATCH`), the transcript sources and their parsers, the asked-question reader, the pane frames, the
 * incremental tail, the send evidence and the question and observed-runtime projections are other owners' code,
 * which Ferrets cannot import (§2.1). The thread's entry module — the host's — builds {@link SessionWorkerPeers}
 * and calls {@link serveSessionWorker} with its own `self`.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  type SessionWorkerDeps,
  SessionWorkerRuntime,
} from '../adapters/session/observer/session-worker-runtime.ts';
import { countWorkerChildren } from '../adapters/session/observer/worker-children.ts';
import { SessionObserver } from '../lib/session/observer/observer.ts';
import type { FromSessionWorker, ToSessionWorker } from '../lib/session/observer/protocol.ts';
import type { QuestionStepPolicy } from '../lib/session/observer/question.ts';

/** The thread's own message scope: what `self` is inside a worker. */
export interface SessionWorkerScope {
  onmessage: ((event: MessageEvent<ToSessionWorker>) => void) | null;
}

/**
 * The parts of a session worker other owners supply. `tmux` builds the session's own ATTACHED, REFUSING control
 * client: anything that is not an allowlisted read is refused without running — that refusal is what keeps a worker
 * from typing; `no-output`, so the pane's bytes are never streamed, only a subscription to its
 * `#{pane_dead} #{window_activity}` says when it drew.
 */
export interface SessionWorkerPeers
  extends Pick<SessionWorkerDeps, 'tmux' | 'transcripts' | 'asked' | 'frames' | 'tail' | 'sendEvidence' | 'paneParsers'> {
  readonly questions: QuestionStepPolicy;
}

/** Runs the session-worker program on `scope`, posting through `post` (the thread's `postMessage`). */
export function serveSessionWorker(
  scope: SessionWorkerScope,
  post: (message: FromSessionWorker) => void,
  peers: SessionWorkerPeers,
): void {
  const nowMs = (): number => performance.timeOrigin + performance.now();
  const children = countWorkerChildren(Bun, nowMs);

  const runtime = new SessionWorkerRuntime({
    post,
    tmux: peers.tmux,
    transcripts: peers.transcripts,
    stat: async file => {
      const info = await stat(file);
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    ...(peers.asked === undefined ? {} : { asked: peers.asked }),
    clock: { now: () => new Date().toISOString() },
    nowMs,
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    children,
    observer: new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex'), peers.questions),
    frames: peers.frames,
    tail: peers.tail,
    sendEvidence: peers.sendEvidence,
    paneParsers: peers.paneParsers,
  });

  scope.onmessage = event => {
    void runtime
      .handle(event.data)
      .catch((error: unknown) =>
        post({ kind: 'fault', message: error instanceof Error ? error.message : String(error), fatal: false }),
      );
  };
}
