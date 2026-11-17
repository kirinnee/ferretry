/**
 * THE DECLARED-WAIT MONITOR, MOUNTED: a ferret that said `signal waiting --until` is woken when the wait ends, its park
 * is held while it lasts, and the proof that something is still watching it is republished (today's monitor loop,
 * `serviceWaiting`). One kernel job ticks it; nothing else does.
 *
 * WHAT A TICK DOES is the monitor service's own (daemon/lib/session/monitor/service.ts): ends a park whose deadline has
 * passed (the signal slice re-checks it under its own lock), tells the ferret through the Mailbox (the harness seam
 * only when nothing provides `ferrets.wake`), holds a status
 * that drifted off `waiting`, and writes `checks/waiting.json` into the ferret's own session folder. The loop then
 * publishes its own record (`monitor-tick.json`) whether or not the tick worked, so a loop that stopped never looks
 * like a fleet with nothing parked.
 *
 * THE QUESTION PLANNER IS NOT HERE. A structured question is Conversation's (its own question watch reads the
 * transcript and the answer ledger), so this loop reconciles none and says no session failed on its account.
 */
import {
  defaultSessionMonitorSettings,
  type MonitorWaits,
  SessionMonitorService,
  type SessionMonitorSettings,
} from '../lib/session/monitor/index.ts';
import type { ClockPort, FileSystemPort } from '../lib/ports.ts';
import type { SessionSendService } from '../lib/session/peers/send.ts';
import { FileWaitHeartbeat } from '../adapters/session/monitor/file-wait-heartbeat.ts';
import { MonitorTickRunner } from '../adapters/session/monitor/monitor-tick-runner.ts';
import { SendMonitorNudge } from '../adapters/session/monitor/send-monitor-nudge.ts';

/** The kernel job that ticks the monitor. Its cadence is the loop's own (`tickIntervalMs`), never the caller's. */
export const MONITOR_TICK_JOB = 'ferrets.monitor-tick';

/** The name the loop publishes its own record under; the writer routes it to Ferrets' own state. */
export const MONITOR_RECORD_NAME = 'monitor-tick.json';

export interface MonitorDeps {
  /** The parks this daemon holds and the two writes a tick makes to one. */
  readonly waits: MonitorWaits;
  /** Where the heartbeat and the loop's record go (`MonitorFiles`). */
  readonly files: Pick<FileSystemPort, 'ensureDirectory' | 'writeTextAtomic'>;
  /** How a woken ferret is told. */
  readonly sends: Pick<SessionSendService, 'send'>;
  readonly clock: ClockPort & { nowMs(): number };
  readonly settings?: SessionMonitorSettings;
}

/** The loop, built over the parks it reads and the three things it writes. */
export function buildMonitor(deps: MonitorDeps): MonitorTickRunner {
  const settings = deps.settings ?? defaultSessionMonitorSettings;
  const monitor = new SessionMonitorService(
    {
      waits: deps.waits,
      // The heartbeat's directory is the ferret's id: `MonitorFiles` reads the first segment as the ferret.
      heartbeats: new FileWaitHeartbeat(id => id, deps.files),
      nudge: new SendMonitorNudge(deps.sends),
      questions: { reconcile: async () => new Map() },
      clock: deps.clock,
      wallClock: deps.clock,
      // The kernel's clock is the only one a test can drive, and the gap it measures is a duration of that same clock.
      monotonic: { elapsedMs: () => deps.clock.nowMs() },
    },
    settings,
  );
  return new MonitorTickRunner(monitor, MONITOR_RECORD_NAME, settings, deps.files);
}
