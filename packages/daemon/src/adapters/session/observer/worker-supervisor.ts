import {
  type AnswerOperationRecord,
  type FromSessionWorker,
  NEW_WORKER,
  type ObserverFacts,
  type ObserverPatch,
  planSessionWorkers,
  type SessionBinding,
  type SessionId,
  sessionWorkerRestart,
  type ToSessionWorker,
  type TranscriptStamp,
  type WorkerAnswers,
  type WorkerAsk,
  type WorkerChild,
  type WorkerLiveness,
} from '../../../lib/index.ts';

/** The part of a Worker the supervisor uses, so a test can stand in a thread that misbehaves on cue. */
export interface ObserverWorker {
  onmessage: ((event: MessageEvent<FromSessionWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ToSessionWorker): void;
  terminate(): void;
  unref?(): void;
  addEventListener?(type: 'close', listener: () => void): void;
}

/** What a worker reported beside a look or an answer, for the profile. */
export interface WorkerLookReport {
  /** A look the worker made, or an answer it gave when asked. */
  readonly kind: 'look' | 'answer';
  readonly lookMs: number;
  readonly children: readonly WorkerChild[];
}

export interface WorkerSupervisorPorts {
  /** Starts one session-worker thread. */
  spawn(): ObserverWorker;
  nowMs(): number;
  /** Runs `run` after `delayMs` without holding the daemon open; answers how to cancel it. */
  schedule(delayMs: number, run: () => void): () => void;
  /** A session given up on a worker, said once (design §3.3). */
  notice(session: SessionId, message: string): void;
  /** Every look's report, so `fy daemon profile` still sees the work (design §6.5). */
  report(report: WorkerLookReport): void;
  /**
   * What a session's worker found, unasked, in the order it must be applied — and which transcript bytes
   * it decided from, so a read can tell whether the worker has seen everything there is.
   */
  observed(session: SessionId, patches: readonly ObserverPatch[], transcript: TranscriptStamp | undefined): void;
  /** A session's screen or transcript tail changed: its liveness look, pushed. */
  liveness(session: SessionId, liveness: WorkerLiveness): void;
  /** A session's pane died, as its worker saw it. */
  exited(session: SessionId): void;
  /** Which sessions are hosted may have changed — a thread answered its probe, crashed, or a back-off ran out. */
  changed(): void;
}

export interface WorkerSupervisorSettings {
  /** Dedicated threads before sessions are pooled into them. */
  readonly cap: number;
  /** A request with no answer this long ends its worker as stuck. */
  readonly requestTimeoutMs: number;
  /** How long an emptied worker is kept before its thread ends. */
  readonly drainMs: number;
  /** How many workers may be starting at once, so a boot does not start every thread together. */
  readonly startConcurrency: number;
}

export const DEFAULT_WORKER_SUPERVISOR_SETTINGS: Omit<WorkerSupervisorSettings, 'cap'> = {
  requestTimeoutMs: 10_000,
  drainMs: 2_000,
  startConcurrency: 2,
};

/** A session the supervisor should host, with what it needs to attach. */
export interface WantedSession {
  readonly id: SessionId;
  readonly facts: ObserverFacts;
  readonly binding: SessionBinding;
}

interface PendingRequest {
  readonly thread: number;
  readonly session: SessionId;
  readonly generation: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancel: () => void;
}

interface Thread {
  readonly id: number;
  readonly worker: ObserverWorker;
  readonly sessions: Set<SessionId>;
  ready: boolean;
  ended: boolean;
  drain: (() => void) | undefined;
}

interface Placement {
  readonly thread: number;
  readonly generation: number;
  binding: SessionBinding;
}

const sameBinding = (a: SessionBinding, b: SessionBinding): boolean =>
  a.tmux.executable === b.tmux.executable &&
  a.tmux.socket === b.tmux.socket &&
  a.tmux.target === b.tmux.target &&
  a.transcript?.file === b.transcript?.file &&
  a.transcript?.harness === b.transcript?.harness;

/**
 * THE SESSION WORKERS: which thread observes which session, and what happens when one fails.
 *
 * One thread per running session up to the cap, then least-loaded pooling (`planSessionWorkers`). A
 * thread is started, asked the `fyd --check` probe, and hosts sessions only once it has answered — until
 * then, and whenever a session has no worker, the caller observes it on the main thread as stage 3a did.
 *
 * FAILURE IS A GENERATION. A thread that errors, closes, or leaves a look unanswered past the timeout is
 * ended; every look waiting on it is refused (its caller looks once itself), every session it hosted is
 * re-attached at a NEW generation after a back-off of 1 s, 2 s, 4 s … 60 s, and any message from the old
 * generation is ignored. Five crashes of one session inside ten minutes keep it on the main thread until
 * the daemon next starts, said once through `notice` (design §3.3).
 */
export class WorkerSupervisor {
  private readonly threads = new Map<number, Thread>();
  private readonly placements = new Map<SessionId, Placement>();
  private readonly generations = new Map<SessionId, number>();
  private readonly crashes = new Map<SessionId, number[]>();
  private readonly retryAt = new Map<SessionId, number>();
  private readonly inline = new Set<SessionId>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextThread = 1;
  private nextRequest = 1;
  private closed = false;

  constructor(
    private readonly ports: WorkerSupervisorPorts,
    private readonly settings: WorkerSupervisorSettings,
  ) {}

  /** Looks waiting on a worker: the gauge `fy daemon profile` samples. */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * The pool as `fy daemon status` and a performance report show it: the configured size, the threads
   * running now, and how many sessions each observes, busiest first.
   */
  get pool(): { readonly max: number; readonly threads: number; readonly sessionsPerThread: readonly number[] } {
    const running = [...this.threads.values()].filter(thread => !thread.ended);
    return {
      max: this.settings.cap,
      threads: running.length,
      sessionsPerThread: running.map(thread => thread.sessions.size).sort((a, b) => b - a),
    };
  }

  /** Threads running now. */
  get threadCount(): number {
    return [...this.threads.values()].filter(thread => !thread.ended).length;
  }

  /** Whether `session` is observed by a worker that has started: if not, the caller observes it inline. */
  hosts(session: SessionId): boolean {
    const placement = this.placements.get(session);
    return placement !== undefined && this.threads.get(placement.thread)?.ready === true;
  }

  /** Whether `session` has been handed to a worker, ready or still starting: messages to it are queued. */
  attached(session: SessionId): boolean {
    return this.placements.has(session);
  }

  /**
   * Make hosting match `wanted`: detach what left, start or pool what arrived, rebind what moved.
   * Sessions held back by a back-off or kept inline are left to the caller. Answers the sessions it attached
   * just now, whose answer receipts the caller then pushes.
   */
  reconcile(wanted: readonly WantedSession[]): readonly SessionId[] {
    if (this.closed) return [];
    const attached: SessionId[] = [];
    const now = this.ports.nowMs();
    const eligible = wanted.filter(
      session => !this.inline.has(session.id) && (this.retryAt.get(session.id) ?? 0) <= now,
    );
    const byId = new Map(eligible.map(session => [session.id, session]));
    const hosted = new Map<number, SessionId[]>();
    for (const thread of this.threads.values()) if (!thread.ended) hosted.set(thread.id, [...thread.sessions]);
    const plan = planSessionWorkers(
      eligible.map(session => session.id),
      hosted,
      this.settings.cap,
    );
    for (const { session } of plan.detach) this.detach(session);
    for (const id of plan.terminate) this.scheduleDrain(id);
    let starting = [...this.threads.values()].filter(thread => !thread.ended && !thread.ready).length;
    for (const { session, worker } of plan.attach) {
      const wantedSession = byId.get(session);
      if (wantedSession === undefined) continue;
      if (worker === NEW_WORKER) {
        if (starting >= this.settings.startConcurrency) continue;
        starting += 1;
        this.attach(wantedSession, this.start().id);
      } else this.attach(wantedSession, worker);
      attached.push(session);
    }
    for (const session of eligible) {
      const placement = this.placements.get(session.id);
      if (placement === undefined || sameBinding(placement.binding, session.binding)) continue;
      placement.binding = session.binding;
      this.post(placement.thread, {
        kind: 'bind',
        session: session.id,
        generation: placement.generation,
        binding: session.binding,
      });
    }
    return attached;
  }

  /** The session's transcript changed: its worker looks again. */
  file(session: SessionId): void {
    const placement = this.placements.get(session);
    if (placement !== undefined)
      this.post(placement.thread, { kind: 'file', session, generation: placement.generation });
  }

  /** The session's answer receipts, after the answer ledger was appended to. */
  answers(session: SessionId, rows: readonly AnswerOperationRecord[]): void {
    const placement = this.placements.get(session);
    if (placement !== undefined)
      this.post(placement.thread, { kind: 'answers', session, generation: placement.generation, rows });
  }

  /** The main thread wrote this session's document: tell its worker what it now says. */
  facts(session: SessionId, facts: ObserverFacts): void {
    const placement = this.placements.get(session);
    if (placement !== undefined)
      this.post(placement.thread, { kind: 'facts', session, generation: placement.generation, facts });
  }

  /**
   * Ask the session's worker for an answer now. Rejects when it could not answer in time, or hosts no
   * worker yet — the caller then does the work once itself, on this thread.
   */
  async request<K extends WorkerAsk['kind']>(
    session: SessionId,
    ask: Extract<WorkerAsk, { kind: K }>,
  ): Promise<WorkerAnswers[K]> {
    const placement = this.placements.get(session);
    const thread = placement === undefined ? undefined : this.threads.get(placement.thread);
    if (placement === undefined || thread?.ready !== true) throw new Error(`no worker observes ${session}`);
    const request = this.nextRequest++;
    return await new Promise<WorkerAnswers[K]>((resolve, reject) => {
      const cancel = this.ports.schedule(this.settings.requestTimeoutMs, () =>
        this.crash(
          thread.id,
          `a ${ask.kind} request for ${session} had no answer within ${String(this.settings.requestTimeoutMs)} ms`,
        ),
      );
      this.pending.set(request, {
        thread: thread.id,
        session,
        generation: placement.generation,
        resolve: value => resolve(value as WorkerAnswers[K]),
        reject,
        cancel,
      });
      this.post(thread.id, { kind: 'request', session, generation: placement.generation, request, ask });
    });
  }

  /** Ends every thread and refuses every look still waiting: the daemon is stopping. */
  close(): void {
    this.closed = true;
    for (const thread of [...this.threads.values()]) this.end(thread, new Error('the session workers were closed'));
  }

  private start(): Thread {
    const id = this.nextThread++;
    const worker = this.ports.spawn();
    const thread: Thread = { id, worker, sessions: new Set(), ready: false, ended: false, drain: undefined };
    this.threads.set(id, thread);
    worker.unref?.();
    worker.onmessage = event => this.receive(thread, event.data);
    worker.onerror = event => this.crash(id, `the worker failed: ${event.message}`);
    worker.addEventListener?.('close', () => this.crash(id, 'the worker exited'));
    // Ready once it answers the probe: until then its sessions are observed inline.
    worker.postMessage({ probe: true });
    return thread;
  }

  private attach(session: WantedSession, threadId: number): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.ended) return;
    const generation = (this.generations.get(session.id) ?? 0) + 1;
    this.generations.set(session.id, generation);
    thread.sessions.add(session.id);
    this.placements.set(session.id, { thread: threadId, generation, binding: session.binding });
    this.post(threadId, {
      kind: 'attach',
      session: session.id,
      generation,
      facts: session.facts,
      binding: session.binding,
    });
  }

  private detach(session: SessionId): void {
    const placement = this.placements.get(session);
    if (placement === undefined) return;
    this.placements.delete(session);
    this.threads.get(placement.thread)?.sessions.delete(session);
    this.post(placement.thread, { kind: 'detach', session, generation: placement.generation });
  }

  private scheduleDrain(threadId: number): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.ended || thread.drain !== undefined) return;
    thread.drain = this.ports.schedule(this.settings.drainMs, () => {
      thread.drain = undefined;
      if (thread.sessions.size === 0) this.end(thread, new Error('the worker was drained'));
    });
  }

  private receive(thread: Thread, message: FromSessionWorker): void {
    if (thread.ended) return;
    if ('probe' in message) {
      thread.ready = true;
      this.ports.changed();
      return;
    }
    switch (message.kind) {
      case 'observed':
        this.ports.report({ kind: 'look', lookMs: message.lookMs, children: message.metrics.children });
        if (this.current(thread, message.session, message.generation))
          this.ports.observed(message.session as SessionId, message.patches, message.transcript);
        return;
      case 'liveness':
        if (this.current(thread, message.session, message.generation))
          this.ports.liveness(message.session as SessionId, message.liveness);
        return;
      case 'answered': {
        const pending = this.pending.get(message.request);
        this.ports.report({ kind: 'answer', lookMs: 0, children: message.metrics.children });
        if (pending === undefined || pending.generation !== message.generation) return;
        this.pending.delete(message.request);
        pending.cancel();
        if (message.failure === undefined) pending.resolve(message.value);
        else pending.reject(new Error(message.failure));
        return;
      }
      case 'exited':
        if (this.current(thread, message.session, message.generation)) this.ports.exited(message.session as SessionId);
        return;
      case 'fault':
        if (message.fatal) this.crash(thread.id, message.message);
        return;
    }
  }

  /** Whether a message names the session's current generation on this thread: anything else is stale. */
  private current(thread: Thread, session: string, generation: number): boolean {
    const placement = this.placements.get(session as SessionId);
    return placement?.thread === thread.id && placement.generation === generation;
  }

  private crash(threadId: number, reason: string): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.ended || this.closed) return;
    const now = this.ports.nowMs();
    for (const session of thread.sessions) {
      const history = [...(this.crashes.get(session) ?? []), now];
      this.crashes.set(session, history);
      const verdict = sessionWorkerRestart(history, now);
      if (verdict.kind === 'inline') {
        this.inline.add(session);
        this.ports.notice(
          session,
          `${session} crashed its session worker ${String(history.length)} times in ten minutes and is observed on the main thread until the daemon restarts; the last failure: ${reason}`,
        );
      } else {
        this.retryAt.set(session, now + verdict.afterMs);
        // Nothing else would bring the session back to a worker: say so when its back-off is over.
        this.ports.schedule(verdict.afterMs, () => this.ports.changed());
      }
    }
    this.end(thread, new Error(reason));
    this.ports.changed();
  }

  private end(thread: Thread, error: Error): void {
    if (thread.ended) return;
    thread.ended = true;
    thread.drain?.();
    for (const session of thread.sessions) this.placements.delete(session);
    thread.sessions.clear();
    for (const [request, pending] of this.pending) {
      if (pending.thread !== thread.id) continue;
      this.pending.delete(request);
      pending.cancel();
      pending.reject(error);
    }
    try {
      thread.worker.terminate();
    } catch {
      // Already gone.
    }
    this.threads.delete(thread.id);
  }

  private post(threadId: number, message: ToSessionWorker): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.ended) return;
    try {
      thread.worker.postMessage(message);
    } catch (error) {
      this.crash(threadId, `a message could not be posted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
