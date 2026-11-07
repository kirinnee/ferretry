import type { DaemonHealthSnapshot, SessionHealthInventory } from '../../../lib/session/health/service.ts';
import type { SessionHealthObservation } from '../../../lib/session/health/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** Statuses from which a session will never run again. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['failed', 'stopped', 'completed', 'stalled']);

/** What the daemon knows about subsystems the self-check can repair. */
export interface SupervisionCapabilities {
  /** True once this daemon runs per-session monitors. */
  readonly monitors: boolean;
  /** True once this daemon arms a warden sweep timer. */
  readonly warden: boolean;
  /** Whether one session currently has a live monitor. Only consulted when `monitors` is true. */
  readonly monitored: (id: string) => boolean;
  /** How often the warden sweeps, in milliseconds. Only consulted when `warden` is true. */
  readonly sweepIntervalMs: number;
  /** When the current timer was armed, so its pre-first-sweep grace is evidence rather than a guess. */
  readonly armedAtMs: () => number | undefined;
  /** The last completed sweep, if any. */
  readonly lastSweepAt: () => string | undefined;
  readonly bootstrapFinished: () => boolean;
  readonly bootstrapErrors: () => readonly string[];
}

/**
 * The self-check's view of the fleet, read from the session index.
 *
 * A session with no status at all is reported as NON-terminal. An index row that lost its status is
 * a row the daemon cannot vouch for, and calling it finished would quietly drop it out of every
 * supervision decision made here — the exact way sessions went missing from listings while their
 * journals kept growing.
 */
export class StorageSessionHealthInventory implements SessionHealthInventory {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly capabilities: SupervisionCapabilities,
  ) {}

  async observe(): Promise<DaemonHealthSnapshot> {
    const sessions: readonly SessionHealthObservation[] = this.storage.listSessions().map(session => ({
      id: session.id,
      terminal: session.status !== undefined && TERMINAL_STATUSES.has(session.status),
      // Never assumed: an unmounted monitor subsystem reports every session unmonitored, and
      // `supervisesMonitors` is what stops that from being read as a fleet-wide fault.
      monitored: this.capabilities.monitors && this.capabilities.monitored(session.id),
    }));
    const lastSweepAt = this.capabilities.lastSweepAt();
    const armedAtMs = this.capabilities.armedAtMs();
    return {
      sessions,
      sweep: {
        timerArmed: this.capabilities.warden,
        intervalMs: this.capabilities.sweepIntervalMs,
        ...(armedAtMs === undefined ? {} : { armedAtMs }),
        ...(lastSweepAt === undefined ? {} : { lastSweepAt }),
      },
      bootstrapFinished: this.capabilities.bootstrapFinished(),
      bootstrapErrors: this.capabilities.bootstrapErrors(),
      supervisesMonitors: this.capabilities.monitors,
      supervisesWarden: this.capabilities.warden,
    };
  }
}
