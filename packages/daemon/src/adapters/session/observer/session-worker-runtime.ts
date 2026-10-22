import type { ClockPort } from '../../../lib/ports.ts';
import type { ObserverFacts } from '../../../lib/session/observer/facts.ts';
import {
  INITIAL_OBSERVER_STATE,
  type ObserverState,
  type SessionObserver,
  type TurnPatch,
} from '../../../lib/session/observer/observer.ts';
import type {
  FromSessionWorker,
  SessionBinding,
  ToSessionWorker,
  WorkerChild,
} from '../../../lib/session/observer/protocol.ts';
import { TURN_TAIL_EVENTS, type TurnLook } from '../../../lib/session/observer/turn.ts';
import { tailTranscriptEvents } from '../../../lib/session/transcript/reader.ts';
import { isTurnStatus } from '../../../lib/session/turn/policy.ts';
import type { TmuxCommandPort } from '../../../lib/tmux/contracts.ts';
import { TmuxController } from '../../../lib/tmux/controller.ts';
import type { TranscriptEvent, TranscriptSource } from '../../../lib/transcript/types.ts';
import { PaneFrames } from '../turn/pane-frames.ts';

/** One session's attached tmux client, as a worker holds it. */
export interface WorkerTmuxClient {
  readonly port: TmuxCommandPort;
  close(): void;
}

/** What a session worker reads through. Nothing here can write: no storage, no file write, no `send-keys`. */
export interface SessionWorkerDeps {
  readonly post: (message: FromSessionWorker) => void;
  /** The session's own read-only attached control client (`bin/session.worker.ts` builds it). */
  readonly tmux: (binding: SessionBinding['tmux']) => WorkerTmuxClient;
  readonly transcripts: Readonly<Record<'claude' | 'codex', TranscriptSource>>;
  readonly stat: (file: string) => Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>;
  readonly clock: ClockPort;
  readonly nowMs: () => number;
  /** The children this worker started since the last report. */
  readonly children: () => readonly WorkerChild[];
  readonly observer: SessionObserver;
}

interface CachedTail {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly events: readonly TranscriptEvent[];
}

/** One hosted session. Mutable on purpose: this is the worker's own per-session record. */
interface Hosted {
  readonly session: string;
  readonly generation: number;
  facts: ObserverFacts;
  state: ObserverState;
  binding: SessionBinding;
  tmux: WorkerTmuxClient;
  frames: PaneFrames;
  tail: CachedTail | undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sameTmux = (a: SessionBinding['tmux'], b: SessionBinding['tmux']): boolean =>
  a.executable === b.executable && a.socket === b.socket && a.target === b.target;

/**
 * A SESSION WORKER'S PROGRAM: the session observer's turn part, for the sessions this thread hosts.
 *
 * It holds, per session, what the main thread's turn watcher held — the observer state (the previous
 * observation for two-frame confirmation), the last captured frame, the last parsed tail — plus the
 * session's own READ-ONLY attached `tmux -C` client, so a capture is a line on a pipe rather than a
 * process. A `look` reads the pane and the transcript, runs the fold, and answers the turn patch; the
 * main thread is the one that writes it (`SessionObservationApplier`). Messages for a generation that
 * is not the session's current one are ignored, so a late answer from a replaced attach changes nothing.
 *
 * `bin/session.worker.ts` is wiring only; this is the program, testable without a thread.
 */
export class SessionWorkerRuntime {
  private readonly hosted = new Map<string, Hosted>();

  constructor(private readonly deps: SessionWorkerDeps) {}

  /** How many sessions this worker hosts right now. */
  get size(): number {
    return this.hosted.size;
  }

  async handle(input: ToSessionWorker): Promise<void> {
    if ('probe' in input) {
      this.deps.post({ probe: true });
      return;
    }
    switch (input.kind) {
      case 'attach': {
        this.drop(input.session);
        const tmux = this.deps.tmux(input.binding.tmux);
        this.hosted.set(input.session, {
          session: input.session,
          generation: input.generation,
          facts: input.facts,
          state: INITIAL_OBSERVER_STATE,
          binding: input.binding,
          tmux,
          frames: new PaneFrames(new TmuxController(tmux.port), this.deps.clock),
          tail: undefined,
        });
        return;
      }
      case 'facts': {
        const hosted = this.current(input.session, input.generation);
        if (hosted !== undefined) hosted.facts = input.facts;
        return;
      }
      case 'bind': {
        const hosted = this.current(input.session, input.generation);
        if (hosted === undefined) return;
        if (!sameTmux(hosted.binding.tmux, input.binding.tmux)) {
          hosted.tmux.close();
          hosted.tmux = this.deps.tmux(input.binding.tmux);
          hosted.frames = new PaneFrames(new TmuxController(hosted.tmux.port), this.deps.clock);
        }
        if (hosted.binding.transcript?.file !== input.binding.transcript?.file) hosted.tail = undefined;
        hosted.binding = input.binding;
        return;
      }
      case 'answers':
        // Carried for the question part (stage 3c); the turn part decides nothing from them.
        return;
      case 'look':
        await this.look(input.session, input.generation, input.request);
        return;
      case 'detach': {
        if (this.current(input.session, input.generation) !== undefined) this.drop(input.session);
        return;
      }
    }
  }

  /** Ends every attached client: the thread is going away. */
  close(): void {
    for (const session of [...this.hosted.keys()]) this.drop(session);
  }

  private async look(session: string, generation: number, request: number): Promise<void> {
    const started = this.deps.nowMs();
    const hosted = this.current(session, generation);
    const answer = (fields: { readonly patch?: TurnPatch; readonly failure?: string }) =>
      this.deps.post({
        kind: 'looked',
        session,
        generation,
        request,
        ...fields,
        lookMs: this.deps.nowMs() - started,
        metrics: { children: this.deps.children() },
      });
    if (hosted === undefined) {
      answer({ failure: `this worker does not host ${session} at generation ${String(generation)}` });
      return;
    }
    try {
      const facts = hosted.facts;
      let look: TurnLook | undefined;
      if (isTurnStatus(facts.status)) {
        const [transcript, pane] = await Promise.all([
          this.transcript(hosted),
          hosted.frames.evidence(hosted.binding.tmux.target),
        ]);
        look = { transcript, pane };
      }
      // Detached or re-attached while it looked: the answer belongs to nobody.
      if (this.hosted.get(session) !== hosted) {
        answer({ failure: `${session} was detached while it was looked at` });
        return;
      }
      const step = this.deps.observer.step(hosted.state, { kind: 'look', facts, turn: { look } });
      hosted.state = step.state;
      const patch = step.patches.find(candidate => candidate.kind === 'turn');
      answer(patch === undefined ? {} : { patch });
    } catch (error) {
      answer({ failure: message(error) });
    }
  }

  /**
   * The transcript's tail, re-parsed only when its file has CHANGED — size or modification time — so an
   * idle session costs a `stat` per look, not a parse. Read in this worker, never on the main thread.
   */
  private async transcript(hosted: Hosted): Promise<readonly TranscriptEvent[] | undefined> {
    const bound = hosted.binding.transcript;
    if (bound === undefined) return undefined;
    const stats = await this.deps.stat(bound.file).catch(() => undefined);
    if (stats === undefined) return undefined;
    const cached = hosted.tail;
    if (cached?.file === bound.file && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs)
      return cached.events;
    const events = await tailTranscriptEvents(
      this.deps.transcripts[bound.harness],
      bound.file,
      hosted.session,
      TURN_TAIL_EVENTS,
    ).catch(() => undefined);
    if (events === undefined) return undefined;
    hosted.tail = { file: bound.file, size: stats.size, mtimeMs: stats.mtimeMs, events };
    return events;
  }

  private current(session: string, generation: number): Hosted | undefined {
    const hosted = this.hosted.get(session);
    return hosted?.generation === generation ? hosted : undefined;
  }

  private drop(session: string): void {
    const hosted = this.hosted.get(session);
    if (hosted === undefined) return;
    hosted.tmux.close();
    hosted.frames.forget(hosted.binding.tmux.target);
    this.hosted.delete(session);
  }
}
