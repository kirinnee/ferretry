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
import { type LoopBlockedClockPort, UNNAMED_SELF_CHECK_STAGES } from '../lib/session/health/types.ts';

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
}

export interface Health {
  readonly service: SessionHealthService;
  readonly settings: SessionHealthSettings;
  /** One firing of the timer. Never rejects: a check that fails is a warning, and the next tick is a minute away. */
  readonly tick: () => Promise<SelfCheckOutcome | undefined>;
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
    monotonic: new SystemMonotonicClock(),
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
    tick: async () =>
      await service.tick().catch((error: unknown) => {
        deps.log.warn('the daemon self-check failed', { error: error instanceof Error ? error.name : 'unknown' });
        return undefined;
      }),
  };
}
