import {
  type FromSessionWorker,
  NEW_WORKER,
  type ObserverFacts,
  planSessionWorkers,
  type SessionBinding,
  type SessionId,
  sessionWorkerRestart,
  type ToSessionWorker,
  type TurnPatch,
  type WorkerChild,
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

/** What one look reported beside its answer, for the profile. */
export interface WorkerLookReport {
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
}

export interface WorkerSupervisorSettings {
  /** Dedicated threads before sessions are pooled into them. */
  readonly cap: number;
  /** A look with no answer this long ends its worker as stuck. */
  readonly lookTimeoutMs: number;
  /** How long an emptied worker is kept before its thread ends. */
  readonly drainMs: number;
  /** How many workers may be starting at once, so a boot does not start every thread together. */
  readonly startConcurrency: number;
}

export const DEFAULT_WORKER_SUPERVISOR_SETTINGS: Omit<WorkerSupervisorSettings, 'cap'> = {
  lookTimeoutMs: 10_000,
  drainMs: 2_000,
  startConcurrency: 2,
};

/** A session the supervisor should host, with what it needs to attach. */
export interface WantedSession {
  readonly id: SessionId;
  readonly facts: ObserverFacts;
  readonly binding: SessionBinding;
}

interface PendingLook {
  readonly thread: number;
  readonly session: SessionId;
  readonly generation: number;
  readonly resolve: (patch: TurnPatch | undefined) => void;
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
  private readonly pending = new Map<number, PendingLook>();
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

  /** Threads running now. */
  get threadCount(): number {
    return [...this.threads.values()].filter(thread => !thread.ended).length;
  }

  /** Whether `session` is observed by a worker that has started: if not, the caller observes it inline. */
  hosts(session: SessionId): boolean {
    const placement = this.placements.get(session);
    return placement !== undefined && this.threads.get(placement.thread)?.ready === true;
  }

  /**
   * Make hosting match `wanted`: detach what left, start or pool what arrived, rebind what moved.
   * Sessions held back by a back-off or kept inline are left to the caller.
   */
  reconcile(wanted: readonly WantedSession[]): void {
    if (this.closed) return;
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
  }

  /** The main thread wrote this session's document: tell its worker what it now says. */
  facts(session: SessionId, facts: ObserverFacts): void {
    const placement = this.placements.get(session);
    if (placement !== undefined)
      this.post(placement.thread, { kind: 'facts', session, generation: placement.generation, facts });
  }

  /**
   * One look by the session's worker: the turn change it implies, or `undefined` for none. Rejects when
   * the worker could not answer — the caller then looks once itself.
   */
  async look(session: SessionId): Promise<TurnPatch | undefined> {
    const placement = this.placements.get(session);
    const thread = placement === undefined ? undefined : this.threads.get(placement.thread);
    if (placement === undefined || thread?.ready !== true) throw new Error(`no worker observes ${session}`);
    const request = this.nextRequest++;
    return await new Promise<TurnPatch | undefined>((resolve, reject) => {
      const cancel = this.ports.schedule(this.settings.lookTimeoutMs, () =>
        this.crash(thread.id, `a look at ${session} had no answer within ${String(this.settings.lookTimeoutMs)} ms`),
      );
      this.pending.set(request, {
        thread: thread.id,
        session,
        generation: placement.generation,
        resolve,
        reject,
        cancel,
      });
      this.post(thread.id, { kind: 'look', session, generation: placement.generation, request });
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
      return;
    }
    switch (message.kind) {
      case 'looked': {
        const pending = this.pending.get(message.request);
        this.ports.report({ lookMs: message.lookMs, children: message.metrics.children });
        if (pending === undefined || pending.generation !== message.generation) return;
        this.pending.delete(message.request);
        pending.cancel();
        if (message.failure === undefined) pending.resolve(message.patch);
        else pending.reject(new Error(message.failure));
        return;
      }
      case 'fault':
        if (message.fatal) this.crash(thread.id, message.message);
        return;
    }
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
      } else this.retryAt.set(session, now + verdict.afterMs);
    }
    this.end(thread, new Error(reason));
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
