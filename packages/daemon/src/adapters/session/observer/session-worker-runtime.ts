import type { ClockPort } from '../../../lib/ports.ts';
import type { ObserverFacts } from '../../../lib/session/observer/facts.ts';
import {
  INITIAL_OBSERVER_STATE,
  type ObserverPatch,
  type ObserverState,
  type SessionObserver,
} from '../../../lib/session/observer/observer.ts';
import type {
  FromSessionWorker,
  SessionBinding,
  ToSessionWorker,
  WorkerAnswers,
  WorkerAsk,
  WorkerChild,
} from '../../../lib/session/observer/protocol.ts';
import { QUESTION_TAIL_EVENTS } from '../../../lib/session/observer/question.ts';
import { TURN_TAIL_EVENTS } from '../../../lib/session/observer/turn.ts';
import type { AnswerOperationRecord } from '../../../lib/session/question/answer-ledger.ts';
import { TranscriptSendEvidence } from '../../../lib/session/send/view.ts';
import { tailTranscriptEvents } from '../../../lib/session/transcript/reader.ts';
import { isTurnStatus } from '../../../lib/session/turn/policy.ts';
import type { TmuxCommandPort } from '../../../lib/tmux/contracts.ts';
import { parsePaneWatch } from '../../../lib/tmux/control-protocol.ts';
import { TmuxController } from '../../../lib/tmux/controller.ts';
import type { TranscriptEvent, TranscriptSource } from '../../../lib/transcript/types.ts';
import { PaneFrames } from '../turn/pane-frames.ts';

/** One session's attached tmux client, as a worker holds it. */
export interface WorkerTmuxClient {
  readonly port: TmuxCommandPort;
  /** Whether its control connection is up, so pane notices are arriving. */
  readonly connected: boolean;
  /** Subscribe to the session's panes' death and activity; answers whether a connection took it. */
  watch(): Promise<boolean>;
  /** Every value of that subscription, as tmux reports it changing. */
  onPaneWatch(listener: (value: string) => void): () => void;
  close(): void;
}

/** How a worker paces its looks. */
export interface SessionWorkerPacing {
  /** After a pane drew or the transcript changed, how long to let it settle before looking. */
  readonly settleMs: number;
  /** The least time between two looks at one session: a pane that draws continuously costs no more. */
  readonly throttleMs: number;
  /** When a look saw an unconfirmed turn end, how soon to look again to confirm it. */
  readonly confirmMs: number;
  /** The longest a session goes unlooked at, whatever happens: a missed event delays, never loses. */
  readonly backstopMs: number;
  /** How often to look while the client is not connected, so no notices can arrive. */
  readonly pollMs: number;
}

export const DEFAULT_SESSION_WORKER_PACING: SessionWorkerPacing = {
  settleMs: 150,
  throttleMs: 2_000,
  confirmMs: 2_000,
  backstopMs: 30_000,
  pollMs: 2_000,
};

/** What a session worker reads through. Nothing here can write: no storage, no file write, no `send-keys`. */
export interface SessionWorkerDeps {
  readonly post: (message: FromSessionWorker) => void;
  /** The session's own read-only attached control client (`bin/session.worker.ts` builds it). */
  readonly tmux: (binding: SessionBinding['tmux']) => WorkerTmuxClient;
  readonly transcripts: Readonly<Record<'claude' | 'codex', TranscriptSource>>;
  readonly stat: (file: string) => Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>;
  readonly clock: ClockPort;
  readonly nowMs: () => number;
  /** Runs `run` after `delayMs`; answers how to cancel it. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  /** The children this worker started since the last report. */
  readonly children: () => readonly WorkerChild[];
  readonly observer: SessionObserver;
  readonly pacing?: SessionWorkerPacing;
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
  /** Bumped by every facts message: a question patch posted before it may be posted again after it. */
  factsSeen: number;
  answers: ReadonlyMap<string, AnswerOperationRecord>;
  state: ObserverState;
  binding: SessionBinding;
  tmux: WorkerTmuxClient;
  stopWatching: () => void;
  frames: PaneFrames;
  tail: CachedTail | undefined;
  /** The transcript changed since it was last read (the hub said so). */
  transcriptDirty: boolean;
  lastLookAt: number;
  look: { readonly at: number; readonly cancel: () => void } | undefined;
  backstop: (() => void) | undefined;
  looking: Promise<void> | undefined;
  lookAgain: boolean;
  questionPosted: { readonly key: string; readonly factsSeen: number } | undefined;
  exited: boolean;
  sendEvidence: TranscriptSendEvidence | undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sameTmux = (a: SessionBinding['tmux'], b: SessionBinding['tmux']): boolean =>
  a.executable === b.executable && a.socket === b.socket && a.target === b.target;

/** How many transcript events the liveness fingerprint covers: enough that a new one always changes it. */
const LIVENESS_EVENTS = 20;

/**
 * A SESSION WORKER'S PROGRAM: the session observer, for the sessions this thread hosts, looking only when
 * something happened (stage 3c of `docs/design/session-workers.md`).
 *
 * WHEN IT LOOKS. The session's own read-only attached tmux client is subscribed to its panes'
 * `#{pane_dead} #{window_activity}` — tmux reports a change at most once a second and streams no pane bytes
 * at all — and the main thread forwards the file-event hub's notice when the transcript changes. Either
 * arms a look after a short settle, never sooner than the throttle after the last one, so a pane drawing
 * continuously costs what the old 2 s tick cost and an idle one costs nothing. A look that saw an
 * unconfirmed turn end looks again to confirm it; a slow backstop looks regardless, so a lost event delays
 * a transition, never loses it; and while the client is down it looks on the old 2 s cadence.
 *
 * WHAT A LOOK DOES. The question part runs before the turn part (#689) and both are posted, in that order,
 * as patches for the one writer on the main thread. The question part also re-runs, with no read at all,
 * when the main thread says the facts or the answer receipts changed. Messages for a generation that is
 * not the session's current one are ignored.
 *
 * `bin/session.worker.ts` is wiring only; this is the program, testable without a thread.
 */
export class SessionWorkerRuntime {
  private readonly hosted = new Map<string, Hosted>();
  private readonly pacing: SessionWorkerPacing;

  constructor(private readonly deps: SessionWorkerDeps) {
    this.pacing = deps.pacing ?? DEFAULT_SESSION_WORKER_PACING;
  }

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
      case 'attach':
        this.attach(input.session, input.generation, input.facts, input.binding);
        return;
      case 'facts': {
        const hosted = this.current(input.session, input.generation);
        if (hosted === undefined) return;
        hosted.facts = input.facts;
        hosted.factsSeen += 1;
        this.questionAgain(hosted);
        return;
      }
      case 'answers': {
        const hosted = this.current(input.session, input.generation);
        if (hosted === undefined) return;
        hosted.answers = new Map(input.rows.map(row => [row.requestId, row]));
        this.questionAgain(hosted);
        return;
      }
      case 'bind': {
        const hosted = this.current(input.session, input.generation);
        if (hosted === undefined) return;
        if (!sameTmux(hosted.binding.tmux, input.binding.tmux)) {
          hosted.stopWatching();
          hosted.tmux.close();
          Object.assign(
            hosted,
            this.open(input.binding.tmux, value => this.paneDrew(hosted, value)),
          );
        }
        if (hosted.binding.transcript?.file !== input.binding.transcript?.file) {
          hosted.tail = undefined;
          hosted.sendEvidence = undefined;
        }
        hosted.binding = input.binding;
        this.wake(hosted);
        return;
      }
      case 'file': {
        const hosted = this.current(input.session, input.generation);
        if (hosted === undefined) return;
        hosted.transcriptDirty = true;
        this.wake(hosted);
        return;
      }
      case 'request':
        await this.request(input.session, input.generation, input.request, input.ask);
        return;
      case 'detach':
        if (this.current(input.session, input.generation) !== undefined) this.drop(input.session);
        return;
    }
  }

  /** Ends every attached client and timer: the thread is going away. */
  close(): void {
    for (const session of [...this.hosted.keys()]) this.drop(session);
  }

  private attach(session: string, generation: number, facts: ObserverFacts, binding: SessionBinding): void {
    this.drop(session);
    const hosted: Hosted = {
      session,
      generation,
      facts,
      factsSeen: 0,
      answers: new Map(),
      state: INITIAL_OBSERVER_STATE,
      binding,
      ...this.open(binding.tmux, value => this.paneDrew(hosted, value)),
      tail: undefined,
      transcriptDirty: false,
      lastLookAt: Number.NEGATIVE_INFINITY,
      look: undefined,
      backstop: undefined,
      looking: undefined,
      lookAgain: false,
      questionPosted: undefined,
      exited: false,
      sendEvidence: undefined,
    };
    this.hosted.set(session, hosted);
    // The first look is at once: a full question projection, posted before any turn patch.
    this.lookAt(hosted, this.deps.nowMs());
  }

  /** The session's own client, subscribed to its panes, and the frames read through it. */
  private open(
    binding: SessionBinding['tmux'],
    drew: (value: string) => void,
  ): Pick<Hosted, 'tmux' | 'frames' | 'stopWatching'> {
    const tmux = this.deps.tmux(binding);
    const stopWatching = tmux.onPaneWatch(drew);
    void tmux.watch().catch(() => false);
    return { tmux, frames: new PaneFrames(new TmuxController(tmux.port), this.deps.clock), stopWatching };
  }

  private paneDrew(hosted: Hosted, value: string): void {
    if (this.hosted.get(hosted.session) !== hosted) return;
    const watched = parsePaneWatch(value);
    if (watched?.dead === true && !hosted.exited) {
      hosted.exited = true;
      this.deps.post({ kind: 'exited', session: hosted.session, generation: hosted.generation });
    }
    this.wake(hosted);
  }

  /** Something happened: look after the settle, but never sooner than the throttle allows. */
  private wake(hosted: Hosted): void {
    const now = this.deps.nowMs();
    this.lookAt(hosted, Math.max(now + this.pacing.settleMs, hosted.lastLookAt + this.pacing.throttleMs));
  }

  /** Arms the next look at `at`, unless one is already armed sooner. */
  private lookAt(hosted: Hosted, at: number): void {
    if (hosted.look !== undefined && hosted.look.at <= at) return;
    hosted.look?.cancel();
    const cancel = this.deps.schedule(Math.max(0, at - this.deps.nowMs()), () => {
      if (hosted.look?.cancel === cancel) hosted.look = undefined;
      void this.look(hosted, false);
    });
    hosted.look = { at, cancel };
  }

  /** One look at a time per session: a look asked for while one runs runs once more after it. */
  private async look(hosted: Hosted, fresh: boolean): Promise<void> {
    if (hosted.looking !== undefined) {
      hosted.lookAgain = true;
      await hosted.looking;
      return;
    }
    hosted.looking = this.lookOnce(hosted, fresh).finally(() => {
      hosted.looking = undefined;
    });
    await hosted.looking;
    if (hosted.lookAgain && this.hosted.get(hosted.session) === hosted) {
      hosted.lookAgain = false;
      this.wake(hosted);
    }
  }

  private async lookOnce(hosted: Hosted, fresh: boolean): Promise<void> {
    const started = this.deps.nowMs();
    const facts = hosted.facts;
    const live = isTurnStatus(facts.status);
    const [events, pane] = await Promise.all([
      this.transcript(hosted, fresh),
      live ? hosted.frames.evidence(hosted.binding.tmux.target).catch(() => undefined) : Promise.resolve(undefined),
    ]).catch(() => [undefined, undefined] as const);
    // Detached or re-attached while it looked: what it found belongs to nobody.
    if (this.hosted.get(hosted.session) !== hosted) return;
    hosted.lastLookAt = this.deps.nowMs();
    const patches: ObserverPatch[] = [...this.question(hosted, events)];
    const step = this.deps.observer.step(hosted.state, {
      kind: 'look',
      facts,
      turn: { look: live ? { transcript: events?.slice(-TURN_TAIL_EVENTS), pane } : undefined },
    });
    hosted.state = step.state;
    patches.push(...step.patches);
    this.deps.post({
      kind: 'observed',
      session: hosted.session,
      generation: hosted.generation,
      patches,
      lookMs: this.deps.nowMs() - started,
      metrics: { children: this.deps.children() },
    });
    // An end seen on one frame only is confirmed by a second look, whether or not anything draws.
    const observation = step.state.turn;
    if (observation !== undefined && !observation.confirmed && observation.state !== facts.turnState)
      this.lookAt(hosted, hosted.lastLookAt + this.pacing.confirmMs);
    // Without a connection no notice can arrive: look on the old cadence, and try to subscribe again.
    if (!hosted.tmux.connected) {
      void hosted.tmux.watch().catch(() => false);
      this.lookAt(hosted, hosted.lastLookAt + this.pacing.pollMs);
    }
    hosted.backstop?.();
    hosted.backstop = this.deps.schedule(this.pacing.backstopMs, () => {
      hosted.backstop = undefined;
      if (this.hosted.get(hosted.session) === hosted) void this.look(hosted, true);
    });
  }

  /** The question part over `events`; posted only when it says something not already posted. */
  private question(hosted: Hosted, events: readonly TranscriptEvent[] | undefined): readonly ObserverPatch[] {
    // A transcript that cannot be proved belongs to this session is not a benign empty one: nothing is said.
    if (events === undefined) return [];
    const step = this.deps.observer.step(hosted.state, {
      kind: 'look',
      question: { state: hosted.facts, events, answers: hosted.answers },
    });
    const patch = step.patches[0];
    if (patch === undefined) return [];
    const key = JSON.stringify(patch);
    if (hosted.questionPosted?.key === key && hosted.questionPosted.factsSeen === hosted.factsSeen) return [];
    hosted.questionPosted = { key, factsSeen: hosted.factsSeen };
    return [patch];
  }

  /** The facts or the receipts changed: decide the question again from the tail already parsed. */
  private questionAgain(hosted: Hosted): void {
    const patches = this.question(hosted, hosted.tail?.events);
    if (patches.length === 0) return;
    this.deps.post({
      kind: 'observed',
      session: hosted.session,
      generation: hosted.generation,
      patches,
      lookMs: 0,
      metrics: { children: this.deps.children() },
    });
  }

  /**
   * The transcript's tail. Re-read only when the hub said it changed, or `fresh` asks (a backstop, a
   * barrier) — and then only when a `stat` says its bytes did — so an idle session reads nothing.
   */
  private async transcript(hosted: Hosted, fresh: boolean): Promise<readonly TranscriptEvent[] | undefined> {
    const bound = hosted.binding.transcript;
    if (bound === undefined) return undefined;
    const cached = hosted.tail;
    if (cached?.file === bound.file && !fresh && !hosted.transcriptDirty) return cached.events;
    hosted.transcriptDirty = false;
    const stats = await this.deps.stat(bound.file).catch(() => undefined);
    if (stats === undefined) return undefined;
    if (cached?.file === bound.file && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs)
      return cached.events;
    const events = await tailTranscriptEvents(
      this.deps.transcripts[bound.harness],
      bound.file,
      hosted.session,
      QUESTION_TAIL_EVENTS,
    ).catch(() => undefined);
    if (events === undefined) return undefined;
    hosted.tail = { file: bound.file, size: stats.size, mtimeMs: stats.mtimeMs, events };
    return events;
  }

  private async request(session: string, generation: number, request: number, ask: WorkerAsk): Promise<void> {
    const hosted = this.current(session, generation);
    const answer = (fields: { readonly value?: unknown; readonly failure?: string }) =>
      this.deps.post({
        kind: 'answered',
        session,
        generation,
        request,
        ...fields,
        metrics: { children: this.deps.children() },
      });
    if (hosted === undefined) {
      answer({ failure: `this worker does not host ${session} at generation ${String(generation)}` });
      return;
    }
    try {
      answer({ value: await this.answer(hosted, ask) });
    } catch (error) {
      answer({ failure: message(error) });
    }
  }

  private async answer(hosted: Hosted, ask: WorkerAsk): Promise<WorkerAnswers[WorkerAsk['kind']]> {
    switch (ask.kind) {
      case 'observe':
        // A barrier: everything posted before this answer is what the transcript says now — so a look
        // already running (perhaps without re-reading it) is waited out and followed by a fresh one.
        while (hosted.looking !== undefined) await hosted.looking;
        await this.look(hosted, true);
        return null;
      case 'pane':
        return (await hosted.frames.state(hosted.binding.tmux.target)) ?? null;
      case 'liveness': {
        const [pane, events] = await Promise.all([
          hosted.frames.state(hosted.binding.tmux.target),
          this.transcript(hosted, false),
        ]);
        return {
          ...(pane === undefined ? {} : { screen: pane.visible }),
          // A fingerprint of the tail, not its text: the Warden keeps only whether it changed.
          ...(events === undefined ? {} : { transcript: JSON.stringify(events.slice(-LIVENESS_EVENTS)) }),
        };
      }
      case 'send-evidence':
        return await this.sendEvidence(hosted).read(hosted.session, ask.since);
    }
  }

  /** The send tracker's evidence over this session's own transcript, read here instead of on the main thread. */
  private sendEvidence(hosted: Hosted): TranscriptSendEvidence {
    if (hosted.sendEvidence !== undefined) return hosted.sendEvidence;
    const evidence = new TranscriptSendEvidence(
      async sessionId => {
        const bound = hosted.binding.transcript;
        return bound === undefined ? undefined : { sessionId, harness: bound.harness };
      },
      {
        file: async () => hosted.binding.transcript?.file,
        window: async (target, start) => {
          const bound = hosted.binding.transcript;
          if (bound === undefined) return undefined;
          return this.deps.transcripts[bound.harness].window(bound.file, { sessionId: target.sessionId, start });
        },
      },
    );
    hosted.sendEvidence = evidence;
    return evidence;
  }

  private current(session: string, generation: number): Hosted | undefined {
    const hosted = this.hosted.get(session);
    return hosted?.generation === generation ? hosted : undefined;
  }

  private drop(session: string): void {
    const hosted = this.hosted.get(session);
    if (hosted === undefined) return;
    this.hosted.delete(session);
    hosted.look?.cancel();
    hosted.backstop?.();
    hosted.stopWatching();
    hosted.tmux.close();
    hosted.frames.forget(hosted.binding.tmux.target);
  }
}
