import {
  type AnswerLedger,
  type ClockPort,
  INITIAL_OBSERVER_STATE,
  isTurnStatus,
  type LivenessSample,
  type LivenessTarget,
  type ObserverPatch,
  type PaneState,
  type ProcessObservation,
  type SendEvidenceReading,
  type SessionBinding,
  type SessionId,
  type SessionObserver,
  type SessionObserverHost,
  SessionTurnWatcher,
  type TranscriptStamp,
  TURN_WATCH_INTERVAL_MS,
  type TurnStateChange,
  type TurnWatchLoop,
  type TurnWatchReport,
  type TurnWatchSession,
  type WorkerLiveness,
} from '../../../lib/index.ts';
import type { InlineObserverHost } from './inline-observer-host.ts';
import type { SessionObservationApplier } from './session-observation-applier.ts';
import type { WantedSession, WorkerSupervisor } from './worker-supervisor.ts';

/** The piece of the file-event hub the host listens through (`FileEventHub` is one). */
export interface ObserverFileEvents {
  subscribe(path: string, listener: (path: string) => void): { close(): void };
}

export interface WorkerObserverPorts {
  /** The observer on this thread: every session no worker has, and every answer a worker could not give. */
  readonly inline: InlineObserverHost;
  readonly supervisor: WorkerSupervisor;
  /** Where a session's evidence is — its tmux session and its proved transcript — resolved on this thread. */
  readonly binding: (id: SessionId) => Promise<SessionBinding | undefined>;
  readonly applier: Pick<SessionObservationApplier, 'apply'>;
  /** The answer queue: a question patch is never written while an answer drive holds the session. */
  readonly answerSerial: { runIfIdle<T>(key: string, work: () => Promise<T>): Promise<T | undefined> };
  readonly answers: Pick<AnswerLedger, 'all'>;
  readonly files: ObserverFileEvents;
  readonly observer: SessionObserver;
  /** What a worker's liveness look cannot do itself: mask the screen, and read the pane's processes. */
  readonly liveness: {
    redact(text: string): Promise<string>;
    processes(tmuxSession: string): Promise<ProcessObservation>;
  };
  readonly clock: ClockPort;
  /** How long a read waits on its session's worker before it projects the session itself. */
  readonly barrierMs: number;
  /** A transcript's size and modification time now, to tell whether a worker has read all of it. */
  readonly stat: (file: string) => Promise<TranscriptStamp | undefined>;
  /** Runs `run` after `delayMs` without holding the daemon open; answers how to cancel it. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  /** Runs one reconcile as the profile's `turn watcher` activity. */
  readonly activity: (work: () => Promise<unknown>) => Promise<unknown>;
}

/** How long after a change the host reconciles hosting: a burst of writes is one reconcile. */
const RECONCILE_SETTLE_MS = 250;
/**
 * The slow backstop: hosting is reconciled at least this often, so what no write announces — a transcript
 * proved after its session started, a pane renamed — still reaches the session's worker.
 */
const RECONCILE_BACKSTOP_MS = 30_000;

/** `promise`, or a rejection once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${String(ms)} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE SESSION OBSERVER, ONE THREAD PER RUNNING SESSION — event-driven (stage 3c of
 * `docs/design/session-workers.md`).
 *
 * A running session's worker observes it — its turn, its open question and observed runtime, its liveness
 * look, its send evidence and its live frame — and posts what changed unasked, when something happened.
 * This thread is the one writer: it applies a session's patches in the order they came, through the one
 * applier (a question patch only while no answer drive holds the session), and it is the one that knows
 * the transcript changed (the file-event hub) and that the answer ledger grew, and tells the worker.
 *
 * WHAT THIS THREAD STILL DOES. The 2 s tick decides which sessions get a worker and observes, as stage 3a
 * did, every session that has none — starting, backing off, kept inline after five crashes, or not running
 * but still recording a turn to clear. The monitor's question pass covers only those; for the rest, its
 * parks pass is all that is left. A read that must reflect the transcript asks the worker for a barrier,
 * and any answer a worker cannot give in time is worked out here instead — nothing is ever unobserved.
 */
export class WorkerObserverHost implements SessionObserverHost {
  readonly turns: TurnWatchLoop;
  private readonly unsubscribe: () => void;
  /** Each session's patches, applied one at a time in the order they arrived. */
  private readonly applying = new Map<SessionId, Promise<void>>();
  /** The transcript each hosted session's worker is told about, by session. */
  private readonly watches = new Map<SessionId, { readonly file: string; readonly close: () => void }>();
  /** The transcript bytes each session's worker last decided from. */
  private readonly stamps = new Map<SessionId, TranscriptStamp>();
  /** Each session's last pushed liveness look. */
  private readonly pushed = new Map<SessionId, WorkerLiveness>();
  private readonly loop: WorkerTurnLoop;
  private armed = false;
  private next: { readonly at: number; readonly cancel: () => void } | undefined;
  private ticking = false;
  private tickAgain = false;

  constructor(private readonly ports: WorkerObserverPorts) {
    this.loop = new WorkerTurnLoop(ports, this);
    this.turns = this.loop;
    // The worker decides from what this thread knows: every change is forwarded as it is learned — and a
    // change may move a session into or out of the running set, so hosting is reconciled after it.
    this.unsubscribe = ports.inline.onFacts((id, facts) => {
      if (facts !== undefined) ports.supervisor.facts(id, facts);
      this.poke(RECONCILE_SETTLE_MS);
    });
  }

  /**
   * Starts observing. There is no tick: hosting is reconciled now, after every change this thread learns
   * of and whenever a worker becomes ready or a back-off ends, and on a 30 s backstop; and only while some
   * session has no worker — starting, backing off, kept inline after five crashes, or ended with a turn
   * still to clear — is it looked at here every 2 s, as stage 3a did.
   */
  arm(): void {
    this.armed = true;
    this.poke(0);
  }

  /** Reconcile (and look at what no worker has) after `delayMs`, unless that is already due sooner. */
  poke(delayMs = RECONCILE_SETTLE_MS): void {
    if (!this.armed) return;
    const at = Date.parse(this.ports.clock.now()) + delayMs;
    if (this.next !== undefined && this.next.at <= at) return;
    this.next?.cancel();
    const cancel = this.ports.schedule(delayMs, () => {
      if (this.next?.cancel === cancel) this.next = undefined;
      void this.tick();
    });
    this.next = { at, cancel };
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      await this.ports.activity(async () => await this.loop.run()).catch(() => undefined);
    } finally {
      this.ticking = false;
    }
    if (this.tickAgain) {
      this.tickAgain = false;
      this.poke();
    } else this.poke(this.loop.needsInline ? TURN_WATCH_INTERVAL_MS : RECONCILE_BACKSTOP_MS);
  }

  /** What a session's worker found, unasked: applied in order, after anything still being applied. */
  observed(session: SessionId, patches: readonly ObserverPatch[], transcript?: TranscriptStamp): void {
    if (transcript !== undefined) this.stamps.set(session, transcript);
    if (patches.length === 0) return;
    const previous = this.applying.get(session) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (const patch of patches) {
        const at = this.ports.clock.now();
        try {
          if (patch.kind === 'turn') await this.ports.applier.apply(session, patch, at);
          // Never written under a live answer drive: it owns the freshest state, and the facts it writes
          // bring the question back to the worker.
          else
            await this.ports.answerSerial.runIfIdle(
              session,
              async () => await this.ports.applier.apply(session, patch, at),
            );
        } catch {
          // A patch the document refused is the document's verdict; the next look decides again.
        }
      }
    });
    this.applying.set(session, next);
    void next.then(() => {
      if (this.applying.get(session) === next) this.applying.delete(session);
    });
  }

  /** A session's screen or transcript tail changed: what the Warden's next liveness look will use. */
  livenessChanged(session: SessionId, liveness: WorkerLiveness): void {
    this.pushed.set(session, liveness);
  }

  /** The answer ledger grew: the session's worker decides its question from the receipts as they are now. */
  async answersChanged(session: SessionId): Promise<void> {
    if (!this.ports.supervisor.attached(session)) return;
    this.ports.supervisor.answers(session, [...(await this.ports.answers.all(session)).values()]);
  }

  /**
   * A read barrier: what the transcript says is in the document a read then returns. The session's worker
   * looks now and its patches are applied before this resolves; one that cannot is projected here.
   */
  async project(id: SessionId): Promise<void> {
    if (this.ports.supervisor.hosts(id) && (await this.seenAll(id))) {
      await this.applying.get(id);
      return;
    }
    if (this.ports.supervisor.hosts(id))
      try {
        await within(this.ports.supervisor.request(id, { kind: 'observe' }), this.ports.barrierMs);
        await this.applying.get(id);
        return;
      } catch {
        // Fall through: the read gets the main thread's own projection, as before workers.
      }
    await this.ports.inline.project(id);
  }

  /**
   * Whether the session's worker has decided from every byte its transcript holds now: one `stat` here,
   * compared with the bytes its last look read. Then nothing is left for a barrier to show it.
   */
  private async seenAll(id: SessionId): Promise<boolean> {
    const file = this.watches.get(id)?.file;
    const stamp = this.stamps.get(id);
    if (file === undefined || stamp === undefined) return false;
    const now = await this.ports.stat(file).catch(() => undefined);
    return now !== undefined && now.size === stamp.size && now.mtimeMs === stamp.mtimeMs;
  }

  /** The monitor's question pass, for the sessions no worker observes: the rest are their workers'. */
  async questions(): Promise<ReadonlyMap<string, string>> {
    return await this.ports.inline.questions(id => this.ports.supervisor.hosts(id));
  }

  /**
   * The Warden's liveness look: the screen and the transcript's fingerprint from the session's worker,
   * the screen masked and the pane's processes read here — then the same sample a look here takes.
   */
  async liveness(target: LivenessTarget): Promise<LivenessSample> {
    const id = target.id as SessionId;
    if (!this.ports.supervisor.hosts(id)) return await this.ports.inline.liveness(target);
    // Pushed by the worker whenever it changed; asked for only when nothing has been pushed yet.
    const looked =
      this.pushed.get(id) ?? (await this.ports.supervisor.request(id, { kind: 'liveness' }).catch(() => undefined));
    if (looked === undefined) return await this.ports.inline.liveness(target);
    const screen =
      looked.screen === undefined ? undefined : await this.ports.liveness.redact(looked.screen).catch(() => undefined);
    const observed =
      target.tmuxSession === undefined
        ? undefined
        : await this.ports.liveness.processes(target.tmuxSession).catch(() => undefined);
    const children = observed?.kind === 'observed' ? observed.processes.length > 0 : undefined;
    const step = this.ports.observer.step(INITIAL_OBSERVER_STATE, {
      kind: 'look',
      liveness: { screen, transcript: looked.transcript, children },
    });
    return step.samples[0] ?? {};
  }

  async midTurn(): Promise<number> {
    return await this.ports.inline.midTurn();
  }

  /** The live readout's frame: the worker's, captured only if the pane drew since; this thread's otherwise. */
  async pane(id: SessionId): Promise<PaneState | undefined> {
    if (this.ports.supervisor.hosts(id)) {
      const pane = await this.ports.supervisor.request(id, { kind: 'pane' }).catch(() => undefined);
      if (pane !== undefined) return pane ?? undefined;
    }
    return await this.ports.inline.pane(id);
  }

  /** The send tracker's evidence, read by the session's worker; by this thread when it cannot. */
  async sendEvidence(id: SessionId, since: string): Promise<SendEvidenceReading> {
    if (this.ports.supervisor.hosts(id)) {
      const reading = await this.ports.supervisor.request(id, { kind: 'send-evidence', since }).catch(() => undefined);
      if (reading !== undefined) return reading;
    }
    return await this.ports.inline.sendEvidence(id, since);
  }

  close(): void {
    this.armed = false;
    this.next?.cancel();
    this.next = undefined;
    this.unsubscribe();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.ports.supervisor.close();
  }

  /** Every hosted session's transcript, watched; a session no worker hosts any more, no longer. */
  reconcileWatches(wanted: readonly WantedSession[]): void {
    const keep = new Map<SessionId, string>();
    for (const session of wanted) {
      const file = session.binding.transcript?.file;
      if (file !== undefined && this.ports.supervisor.hosts(session.id)) keep.set(session.id, file);
    }
    for (const [id, watch] of [...this.watches]) {
      if (keep.get(id) === watch.file) continue;
      watch.close();
      this.watches.delete(id);
      this.stamps.delete(id);
      if (!keep.has(id)) this.pushed.delete(id);
    }
    for (const [id, file] of keep) {
      if (this.watches.has(id)) continue;
      const subscription = this.ports.files.subscribe(file, () => this.ports.supervisor.file(id));
      this.watches.set(id, { file, close: () => subscription.close() });
    }
  }
}

/**
 * The 2 s tick, now only a reconciler: it hands running sessions to their workers and observes on this
 * thread only what no worker has. A worker's looks are its own and arrive as `observed` messages.
 */
class WorkerTurnLoop implements TurnWatchLoop {
  readonly intervalMs = TURN_WATCH_INTERVAL_MS;
  /** The sessions this tick leaves to the main thread; read by the inline watcher's roster. */
  private local: readonly TurnWatchSession[] = [];

  /** Whether the last tick left any session to this thread, which is then looked at again in 2 s. */
  get needsInline(): boolean {
    return this.local.length > 0;
  }
  private readonly inlineWatcher: SessionTurnWatcher;
  private running = false;

  constructor(
    private readonly ports: WorkerObserverPorts,
    private readonly host: WorkerObserverHost,
  ) {
    this.inlineWatcher = new SessionTurnWatcher(ports.inline.turnPortsFor(async () => this.local));
  }

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

  private async tick(): Promise<TurnWatchReport> {
    const sessions = await this.ports.inline.turnRoster();
    const wanted = await this.wanted(sessions);
    const attached = this.ports.supervisor.reconcile(wanted);
    this.host.reconcileWatches(wanted);
    for (const id of attached) void this.host.answersChanged(id).catch(() => undefined);
    this.local = sessions.filter(session => !this.ports.supervisor.hosts(session.id));
    const inline = await this.inlineWatcher.tick();
    const changed = new Map<SessionId, TurnStateChange>(inline.changed);
    const failures = new Map<SessionId, string>(inline.failures);
    return { changed, failures };
  }

  /** The running sessions, with where their evidence is. One whose pane cannot be named stays inline. */
  private async wanted(sessions: readonly TurnWatchSession[]): Promise<readonly WantedSession[]> {
    const running = sessions.filter(session => isTurnStatus(session.state.status));
    const bound = await Promise.all(
      running.map(async session => ({
        session,
        binding: await this.ports.binding(session.id).catch(() => undefined),
      })),
    );
    return bound.flatMap(({ session, binding }) =>
      binding === undefined ? [] : [{ id: session.id, facts: session.state, binding }],
    );
  }
}
