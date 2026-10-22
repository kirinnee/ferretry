import {
  type ClockPort,
  isTurnStatus,
  type LivenessSample,
  type LivenessTarget,
  type SessionBinding,
  type SessionId,
  type SessionObserverHost,
  SessionTurnWatcher,
  TURN_WATCH_INTERVAL_MS,
  type TurnStateChange,
  type TurnWatchLoop,
  type TurnWatchReport,
  type TurnWatchSession,
} from '../../../lib/index.ts';
import type { InlineObserverHost } from './inline-observer-host.ts';
import type { SessionObservationApplier } from './session-observation-applier.ts';
import type { WantedSession, WorkerSupervisor } from './worker-supervisor.ts';

export interface WorkerObserverPorts {
  /** The observer on the main thread: the question and liveness parts, and every session no worker has. */
  readonly inline: InlineObserverHost;
  readonly supervisor: WorkerSupervisor;
  /** Where a session's evidence is — its tmux session and its proved transcript — resolved on this thread. */
  readonly binding: (id: SessionId) => Promise<SessionBinding | undefined>;
  readonly applier: Pick<SessionObservationApplier, 'apply'>;
  readonly clock: ClockPort;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE SESSION OBSERVER, ONE THREAD PER RUNNING SESSION (stage 3b of `docs/design/session-workers.md`).
 *
 * The TURN part of every running session runs on that session's worker: the worker owns the session's
 * read-only attached tmux client and its parsed tail, looks on the same 2 s tick the turn watcher always
 * had, and answers the patch; this thread writes it through the one applier, so the session lock, the
 * journal and every listener are unchanged. The question and liveness parts stay on this thread (the
 * inline host) until stage 3c.
 *
 * NOTHING IS LEFT UNOBSERVED. A session with no worker yet (starting, backing off after a crash, kept
 * inline after five), a session that is not running but still has a turn record to clear, and a look a
 * worker could not answer are all observed by the inline host's own turn path, exactly as in stage 3a.
 */
export class WorkerObserverHost implements SessionObserverHost {
  readonly turns: TurnWatchLoop;
  private readonly unsubscribe: () => void;

  constructor(private readonly ports: WorkerObserverPorts) {
    this.turns = new WorkerTurnLoop(ports);
    // The worker decides from what the main thread knows: every change is forwarded as it is learned.
    this.unsubscribe = ports.inline.onFacts((id, facts) => {
      if (facts !== undefined) ports.supervisor.facts(id, facts);
    });
  }

  async project(id: SessionId): Promise<void> {
    await this.ports.inline.project(id);
  }

  async questions(): Promise<ReadonlyMap<string, string>> {
    return await this.ports.inline.questions();
  }

  async liveness(target: LivenessTarget): Promise<LivenessSample> {
    return await this.ports.inline.liveness(target);
  }

  async midTurn(): Promise<number> {
    return await this.ports.inline.midTurn();
  }

  close(): void {
    this.unsubscribe();
    this.ports.supervisor.close();
  }
}

/** The 2 s turn tick, split between the session workers and the main thread. */
class WorkerTurnLoop implements TurnWatchLoop {
  readonly intervalMs = TURN_WATCH_INTERVAL_MS;
  /** The sessions this tick leaves to the main thread; read by the inline watcher's roster. */
  private local: readonly TurnWatchSession[] = [];
  private readonly inlineWatcher: SessionTurnWatcher;
  private running = false;

  constructor(private readonly ports: WorkerObserverPorts) {
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
    this.ports.supervisor.reconcile(wanted);
    const changed = new Map<SessionId, TurnStateChange>();
    const failures = new Map<SessionId, string>();
    const hosted = sessions.filter(session => this.ports.supervisor.hosts(session.id));
    const fallback = new Set<SessionId>();
    // Each worker looks at its own session at once: that is what the threads are for. Writes are still one
    // session at a time through the applier's own lane.
    await Promise.all(
      hosted.map(async session => {
        const patch = await this.ports.supervisor.look(session.id).catch(() => {
          fallback.add(session.id);
          return undefined;
        });
        if (patch === undefined) return;
        try {
          if (await this.ports.applier.apply(session.id, patch, this.ports.clock.now()))
            changed.set(session.id, patch.change);
        } catch (error) {
          failures.set(session.id, message(error));
        }
      }),
    );
    // Decided from the same snapshot the looks were sent from: a worker that became ready meanwhile does not
    // take a session this tick, which would leave it looked at by nobody.
    const sentToWorkers = new Set(hosted.map(session => session.id));
    this.local = sessions.filter(session => !sentToWorkers.has(session.id) || fallback.has(session.id));
    const inline = await this.inlineWatcher.tick();
    for (const [id, change] of inline.changed) changed.set(id, change);
    for (const [id, failure] of inline.failures) failures.set(id, failure);
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
