import { randomUUID } from 'node:crypto';
import type { SessionMonitorService } from '../../../lib/session/monitor/service.ts';
import type { SessionMonitorSettings } from '../../../lib/session/monitor/settings.ts';
import type { MonitorLoop, MonitorTickReport } from '../../../lib/session/monitor/types.ts';
import { writeJsonAtomic } from './atomic-json.ts';

/**
 * One turn of the daemon's monitor loop: run the tick, then publish what it did.
 *
 * THE PUBLISH HAPPENS WHETHER OR NOT THE TICK SUCCEEDED, and that is the whole design. A loop that
 * only writes when it works is a loop whose failure looks exactly like a fleet with nothing parked —
 * the shape this migration has now found three times. A failed tick leaves `lastTickAt` where it was
 * and writes `overdue: true` beside the reason it failed, so the record says "the loop is not
 * running" rather than saying nothing at all.
 *
 * THE ERROR IS SWALLOWED, for the reason the self-check tick swallows its own: an unhandled rejection
 * from a background timer takes down a daemon whose fleet is fine, and the failure is already carried
 * by the record this then writes.
 *
 * ONE FILE PER DAEMON, in the state home this process opened. Two daemons on one host have two state
 * homes and therefore two records; neither can overwrite or read the other's.
 */
export class MonitorTickRunner implements MonitorLoop {
  constructor(
    private readonly monitor: SessionMonitorService,
    /** Absolute path of this daemon's monitor record, inside its own state home. */
    private readonly file: string,
    private readonly settings: SessionMonitorSettings,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  /** The cadence the composition root must fire this on: the loop's own, never the caller's choice. */
  get intervalMs(): number {
    return this.settings.tickIntervalMs;
  }

  arm(): void {
    this.monitor.arm();
  }

  /** Runs a tick and publishes the record. Returns what the tick did, or `undefined` if it failed. */
  async run(): Promise<MonitorTickReport | undefined> {
    const report = await this.monitor.tick().catch(() => undefined);
    await this.publish(report).catch(() => undefined);
    return report;
  }

  /** Says the loop has stopped, without touching the storage a shutdown has already closed. */
  async close(): Promise<void> {
    this.monitor.disarm();
    await this.publish(undefined).catch(() => undefined);
  }

  /**
   * Publishes the loop's health, and the last tick's own account of itself.
   *
   * Session ids are named rather than counted. The file is inside the private state home, and the
   * question an operator brings to it is "which park is not being serviced" — a count cannot answer
   * that, and a park nobody can name is a park nobody will fix.
   */
  async publish(report: MonitorTickReport | undefined): Promise<void> {
    const health = this.monitor.health();
    await writeJsonAtomic(
      this.file,
      {
        armed: health.armed,
        overdue: health.overdue,
        ticks: health.ticks,
        sinceLastTickMs: health.sinceLastTickMs,
        parked: health.parked,
        consecutiveFailures: health.consecutiveFailures,
        ...(health.lastTickAt === undefined ? {} : { lastTickAt: health.lastTickAt }),
        ...(health.lastFailure === undefined ? {} : { lastFailure: health.lastFailure }),
        ...(report === undefined
          ? {}
          : {
              lastTick: {
                at: report.at,
                tick: report.tick,
                parked: report.parked,
                expired: report.expired,
                heartbeats: report.heartbeats,
                held: report.held,
                failures: Object.fromEntries(report.failures),
                ...(report.sinceLastTickMs === undefined ? {} : { sinceLastTickMs: report.sinceLastTickMs }),
              },
            }),
      },
      this.uniqueId,
    );
  }
}
