import type { HealthView } from '@ferretry/protocol';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { DaemonHealthReport } from '../../session/health/report.ts';

/**
 * The daemon's own health, as `fy daemon status` reads it.
 *
 * THIS MOUNT FIXES A BROKEN SURFACE, not a missing one. `GET /v1/health` already answered — with
 * `{status, version, uptimeSeconds}`, a shape the protocol's `HealthViewSchema` refuses. The CLI
 * probes this route through that schema and treats a parse failure as "did not answer", so a
 * perfectly healthy daemon reported itself unreachable, and `DirectSupervisor` — which deliberately
 * reads the pid from the health response rather than from a pid file — had no pid to read.
 *
 * Behind it sits `SessionHealthService`, which the composition root has CONSTRUCTED since the daemon
 * gained a state home and never called: the fleet inventory, the self-check ledger, the wedge
 * detector, the consistency pass and the restart coordinator were all built, tested and unreachable.
 * Mounting the report is what makes the measurement a product feature instead of a library.
 *
 * WHAT IT IS NOT. This is a report of what the self-check ALREADY measured, never a fresh probe: a
 * health route that goes and measures is a health route that hangs when the thing it measures does.
 * The service's own `report()` reads its ledgers and the session index and nothing else.
 *
 * SCOPE. `public`, and that is a REQUIREMENT of the surface rather than an oversight. The daemon
 * commands must report whether the daemon is up BEFORE any token exists — exactly the state a fresh
 * `fy daemon install` leaves a host in — so `packages/cli/bin/fy.ts` builds a health client with a
 * placeholder token and relies on the daemon ignoring it. Scoping this route would restore the same
 * "did not answer" that the wrong body caused, for callers holding no credential.
 *
 * What it therefore publishes to any peer that can reach the bound address: the daemon's version and
 * process id, the size and state of the fleet, and its self-check ledger. That is the same class of
 * operational fact the already-public `/usage` and `/metrics` feeds carry, and it is why the route
 * exposes counts rather than session ids. `bootstrapErrorMessages` is the one field that could quote
 * a path inside the state home; the composition root reports no bootstrap errors today, and the unit
 * that starts recording real ones owns the decision about how much of them a public feed may carry.
 */

/**
 * How much scratch space the daemon has reclaimed.
 *
 * Stated by the composition root rather than computed here, because whether a GC runs at all is a
 * fact about which subsystems that daemon mounted. A daemon with no reclaimer reports `enabled:
 * false` beside two zeroes, which reads as "nothing reclaims, so nothing was reclaimed" — unlike a
 * bare zero, which would read as a reclaimer that found nothing to do.
 */
export interface ScratchReclamation {
  readonly enabled: boolean;
  readonly reclaimedSessions: number;
  readonly reclaimedBytes: number;
}

/**
 * The health surface, as this route needs it.
 *
 * `report()` is the domain's own `DaemonHealthReport`. The two fields beside it are the composition
 * root's to state: a process id is a runtime read that `src/lib` may not make, and scratch
 * reclamation is a subsystem this daemon does not have.
 */
export interface DaemonHealthSubsystem {
  report(): Promise<DaemonHealthReport>;
  /** This daemon's process id, so an operator can signal the process that is actually serving. */
  readonly pid: number;
  readonly scratch: ScratchReclamation;
}

/**
 * The report as the client parses it.
 *
 * `bootstrapDegraded` is DERIVED from the state rather than carried beside it, so the boolean and
 * the enum cannot disagree — the wire keeps both because the shipped CLI branches on the boolean and
 * prints the enum.
 *
 * `wardenTimerArmed` is the daemon's `supervisesWarden` fact, not a guess: this daemon arms no sweep
 * timer, and reporting `true` would make a permanently missing sweep look like a broken one.
 */
function view(report: DaemonHealthReport, pid: number, scratch: ScratchReclamation): HealthView {
  return {
    ok: report.ok,
    bootstrapping: report.bootstrapping,
    bootstrapState: report.bootstrapState,
    bootstrapDegraded: report.bootstrapState === 'degraded',
    version: report.version,
    pid,
    sessions: report.sessions,
    running: report.running,
    monitors: report.monitors,
    unmonitoredRunning: report.unmonitoredRunning,
    wardenLastSweepSeconds: report.wardenSweepAgeSeconds,
    wardenTimerArmed: report.supervisesWarden,
    eventLoopLagMs: report.eventLoopLagMs,
    lastSelfCheckAt: report.lastSelfCheckAt,
    wedgeCount: report.wedgeCount,
    scratchGcEnabled: scratch.enabled,
    scratchReclaimedSessions: scratch.reclaimedSessions,
    scratchReclaimedBytes: scratch.reclaimedBytes,
    bootstrapErrors: report.bootstrapErrors,
    // Omitted rather than sent empty: the count above already says there were none, and an empty
    // list would read as "the messages were withheld".
    ...(report.bootstrapErrorMessages === undefined
      ? {}
      : { bootstrapErrorMessages: [...report.bootstrapErrorMessages] }),
    time: report.time,
  };
}

async function health(subsystem: DaemonHealthSubsystem): Promise<ApiResponse> {
  return jsonResponse(view(await subsystem.report(), subsystem.pid, subsystem.scratch));
}

/**
 * `noStore` because every field is a measurement whose entire value is freshness. A cached health
 * response is the failure mode this subsystem exists to catch: a starved daemon reporting all-clear.
 */
export function daemonHealthRoutes(subsystem: DaemonHealthSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/health',
      minimum: 'none',
      noStore: true,
      handle: async () => await health(subsystem),
    },
  ];
}
