import type { Log, StatePort } from '@ferretry/kernel/contract';
import {
  StateSelfRestartStampStore,
  StateSessionHealthEventSink,
  StorageConsistencyPass,
  StorageSessionHealthInventory,
  SystemMonotonicClock,
  UnmountedSupervisionRepair,
} from '../adapters/session/health/index.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import { type SelfCheckOutcome, type SessionHealthPorts, SessionHealthService } from '../lib/session/health/service.ts';
import { SelfRestartCoordinator } from '../lib/session/health/self-restart.ts';
import { defaultSessionHealthSettings, type SessionHealthSettings } from '../lib/session/health/settings.ts';
import {
  type LoopBlockedClockPort,
  type MonotonicClockPort,
  UNNAMED_SELF_CHECK_STAGES,
} from '../lib/session/health/types.ts';

/** The job that runs the daemon's self-check once every `selfCheckIntervalMs` (J-0032, J-0118). */
export const HEALTH_JOB = 'ferrets.self-check';

/** What the self-check stands on, each through its one owner. */
export interface HealthDeps {
  /** Ferrets' own state: `health.jsonl` and `self-restart.json` are the only files the check writes. */
  readonly state: Pick<StatePort, 'append' | 'version' | 'tail' | 'write' | 'read' | 'remove'>;
  readonly storage: Pick<
    DaemonStorage,
    'listSessions' | 'surveySessionDirectories' | 'reconcile' | 'sessionIdsOnDisk' | 'readState' | 'lastEventAt'
  >;
  readonly clock: { now(): string; nowMs(): number };
  /** The kernel's read-only loop-blocked reading: what tells a starved event loop from a stuck check. */
  readonly loop: LoopBlockedClockPort;
  readonly version: string;
  /** Whether the session store loaded, and what it said when it did not (the report's bootstrap facts). */
  readonly bootstrap: { finished(): boolean; errors(): readonly string[] };
  readonly log: Pick<Log, 'warn'>;
  readonly settings?: SessionHealthSettings;
  /** The monotonic reading gaps are measured on. Default: the system's; a test hands in one it drives. */
  readonly monotonic?: MonotonicClockPort;
}

export interface Health {
  readonly service: SessionHealthService;
  readonly settings: SessionHealthSettings;
  /**
   * One firing of the timer. Never rejects: a check that fails is a warning, and the next tick is a minute away. A
   * signal that is already aborted starts nothing.
   */
  readonly tick: (signal?: AbortSignal) => Promise<SelfCheckOutcome | undefined>;
}

/**
 * Today's `createSessionHealth` (`fyd.ts:8475–8484`) over 5.0's owners, REPORT-ONLY.
 *
 * Nothing here deletes, repairs or kills a ferret's files or panes. What the check does write is its own: a line of
 * `health.jsonl` when something is wrong, the self-restart stamp when it asks for a restart, and the session INDEX
 * (a disposable cache of the session folders) when the consistency pass reindexes it.
 *
 * - exits: no-op. A pane the check would settle `exited` is the exit observer's job, mounted with the exit halves.
 * - repair: {@link UnmountedSupervisionRepair}. No per-session monitor and no warden sweep timer is mounted here, so
 *   `supervisesMonitors` and `supervisesWarden` read false and nothing is ever asked to repair.
 * - restart: answers `false`, which the coordinator reports as "NOT restarting: this daemon is not under a service
 *   manager — restart it yourself" (today's sentence). Ferrets holds no lever on the daemon's process (#52 Q6).
 */
export function buildHealth(deps: HealthDeps): Health {
  const settings = deps.settings ?? defaultSessionHealthSettings;
  const ports: SessionHealthPorts = {
    inventory: new StorageSessionHealthInventory(deps.storage, {
      monitors: false,
      warden: false,
      monitored: () => false,
      sweepIntervalMs: 0,
      armedAtMs: () => undefined,
      lastSweepAt: () => undefined,
      bootstrapFinished: deps.bootstrap.finished,
      bootstrapErrors: deps.bootstrap.errors,
    }),
    survey: { survey: async () => await deps.storage.surveySessionDirectories() },
    consistency: new StorageConsistencyPass(deps.storage, settings, UNNAMED_SELF_CHECK_STAGES),
    repair: new UnmountedSupervisionRepair(),
    exits: { observe: async () => [], settle: async () => false },
    events: new StateSessionHealthEventSink(deps.state, deps.clock),
    clock: deps.clock,
    wallClock: deps.clock,
    monotonic: deps.monotonic ?? new SystemMonotonicClock(),
    loop: deps.loop,
    activities: UNNAMED_SELF_CHECK_STAGES,
    restarts: new SelfRestartCoordinator(
      new StateSelfRestartStampStore(deps.state),
      { restart: async () => false },
      settings,
    ),
    version: deps.version,
  };
  const service = new SessionHealthService(ports, settings);
  return {
    service,
    settings,
    tick: async signal =>
      signal?.aborted === true
        ? undefined
        : await service.tick().catch((error: unknown) => {
            deps.log.warn('the daemon self-check failed', { error: error instanceof Error ? error.name : 'unknown' });
            return undefined;
          }),
  };
}

/** How long stopping the daemon waits for a self-check still running before it leaves it behind. */
const SELF_CHECK_STOP_WAIT_MS = 5_000;

/** What the self-check job stands on. */
export interface HealthJobDeps {
  readonly health: Pick<Health, 'tick'>;
  /** Settles once the session store's archive is loaded (it may reject: a load that failed). */
  readonly storeLoaded: Promise<unknown>;
  /** The kernel clock's one-shot timer, for the bound on waiting at stop. */
  readonly after: (delayMs: number, fire: () => void) => () => void;
  /** How long stopping waits for a check in flight. Default {@link SELF_CHECK_STOP_WAIT_MS}. */
  readonly stopWaitMs?: number;
}

/** The self-check job: what the kernel's job runner calls each interval, and what stopping the daemon calls. */
export interface HealthJob {
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * The job STARTS a check and returns without waiting for it.
 *
 * The kernel's job runner coalesces: a fire while a run is still going sets a flag and never calls `run`, then re-fires
 * the moment the slow run ends. A `run` that awaited the check would therefore hide every interval that passes during
 * it from the service. The service could not skip (J-0118: "skips — never overlaps"), could not measure a check that
 * never finishes (the wedge it exists to count), and the re-fire at the end of a check slower than the wedge gap would
 * read the whole run as a gap, call it a wedge, and run the deep pass — the slowest check there is — making the next
 * one slower still. Started and not awaited, every interval reaches the service, which skips while one is running.
 *
 * The check in flight is kept so stopping can wait for it, for a bounded time.
 */
export function buildHealthJob(deps: HealthJobDeps): HealthJob {
  const inflight = new Set<Promise<unknown>>();
  const waitMs = deps.stopWaitMs ?? SELF_CHECK_STOP_WAIT_MS;
  let stopped = false;
  return {
    run: async signal => {
      if (stopped || signal.aborted) return;
      // An archive that did not load names no archived session, and a pass would read every one of them as live.
      if (
        !(await deps.storeLoaded.then(
          () => true,
          () => false,
        ))
      )
        return;
      if (stopped || signal.aborted) return;
      const check: Promise<unknown> = deps.health.tick(signal).finally(() => inflight.delete(check));
      inflight.add(check);
    },
    stop: async () => {
      stopped = true;
      if (inflight.size === 0) return;
      // A check that never finishes is left behind after the bound: stopping the daemon never waits on it for good.
      await new Promise<void>(resolve => {
        const giveUp = deps.after(waitMs, resolve);
        void Promise.allSettled([...inflight]).then(() => {
          giveUp();
          resolve();
        });
      });
    },
  };
}
