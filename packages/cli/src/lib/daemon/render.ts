import { describeSessionWorkerPool, type HealthView, type LivenessView } from '@ferretry/protocol';
import type { DaemonSupervisorReport } from './ports.ts';
import { launchdThrottled, servesOutsideSupervisor } from './probe.ts';
import { LAUNCHD_PROCESS_TYPE } from './unit-file.ts';

/**
 * How far the daemon answered.
 *
 * - `serving` — its full health report answered.
 * - `starting` — it is booting: its liveness answer names the step and how long it has taken.
 * - `busy` — its liveness answer came back but the full report did not in time: up, but slow.
 * - `wedged` — a process exists and answered NOTHING in time. A loop that is not running answers no
 *   request, so this is the state a restart is for.
 * - `stopped` — no daemon is running.
 *
 * "Process exists but its API is unavailable" used to cover the middle three, and a person reading it
 * could not tell a daemon twenty seconds into a boot from one that had been stuck for an hour.
 */
export type DaemonReachability = 'serving' | 'starting' | 'busy' | 'wedged' | 'stopped';

/** What `daemon status` concluded, before it is turned into text or JSON. */
export interface DaemonStatusView {
  readonly daemon: string;
  readonly reachability: DaemonReachability;
  readonly supervisor: DaemonSupervisorReport;
  readonly health?: HealthView | undefined;
  /** The daemon's liveness answer, when it gave one: its boot step and how late its loop has run. */
  readonly liveness?: LivenessView | undefined;
  /** Serving, but not as the installed service manager's daemon. See `servesOutsideSupervisor`. */
  readonly orphan: boolean;
}

/**
 * Decides what `daemon status` reports.
 *
 * The live HTTP API is the ground truth for reachability: a unit-and-pid check alone reports
 * "stopped" for a daemon started outside the service manager, which broke every consumer that probed
 * reachability this way.
 */
export function decideDaemonStatus(
  daemon: string,
  supervisor: DaemonSupervisorReport,
  health: HealthView | undefined,
  liveness?: LivenessView,
): DaemonStatusView {
  const answered = liveness === undefined ? {} : { liveness };
  if (health !== undefined) {
    return {
      daemon,
      reachability: 'serving',
      supervisor,
      health,
      ...answered,
      orphan: servesOutsideSupervisor(supervisor, health),
    };
  }
  if (liveness !== undefined)
    return {
      daemon,
      reachability: liveness.status === 'starting' ? 'starting' : 'busy',
      supervisor,
      ...answered,
      orphan: false,
    };
  const alive = supervisor.state === 'running';
  return { daemon, reachability: alive ? 'wedged' : 'stopped', supervisor, orphan: false };
}

/**
 * A step this old is not a slow step. Long enough for the largest honest boot step measured — a first
 * self-check over a big fleet takes seconds, not minutes — and short enough that a stuck boot is called
 * stuck the first time someone looks.
 */
const STUCK_STEP_SECONDS = 120;

type LoopStallView = NonNullable<NonNullable<LivenessView['eventLoop']>['lastStall']>;

/** The work a stall ran during: the deepest labels when the daemon reports them, every label otherwise. */
function stallSuspects(stall: LoopStallView): string {
  const named = stall.innermost !== undefined && stall.innermost.length > 0 ? stall.innermost : stall.during;
  return named.length === 0 ? '' : ` during ${named.join(', ')}`;
}

/** Where a stall's sampled stack spent it, as an indented line, or nothing when it was not sampled. */
function stallStackLine(label: string, stall: LoopStallView | undefined): string[] {
  const hottest = stall?.stacks?.[0];
  if (hottest === undefined) return [];
  return [`    ${label}: ${String(Math.round(hottest.share * 100))}% in ${hottest.stack}`];
}

/**
 * How the loop has been running, when the daemon has stalled at all: none, one line, or — when the
 * worst stall is not the last one — a second naming the worst, each followed by where its sampled stack
 * spent the time. "Worst 14.3s" with nothing about what it was is a number nobody can act on.
 */
function stallLine(liveness: LivenessView | undefined): string[] {
  const stall = liveness?.eventLoop?.lastStall;
  if (stall === undefined) return [];
  const worst = liveness?.eventLoop?.worstStall;
  const worstIsLast = worst === undefined || (worst.at === stall.at && worst.durationMs === stall.durationMs);
  return [
    `  event loop stalled ${String(liveness?.eventLoop?.stalls ?? 1)}x, worst ${((liveness?.eventLoop?.maxLagMs ?? stall.durationMs) / 1_000).toFixed(1)}s; last ${(stall.durationMs / 1_000).toFixed(1)}s at ${stall.at}${stallSuspects(stall)}`,
    ...stallStackLine('last', stall),
    ...(worstIsLast
      ? []
      : [
          `  worst stall ${(worst.durationMs / 1_000).toFixed(1)}s at ${worst.at}${stallSuspects(worst)}`,
          ...stallStackLine('worst', worst),
        ]),
  ];
}

const pidOf = (view: DaemonStatusView): string => {
  const pid = view.liveness?.pid ?? view.supervisor.pid;
  return pid === undefined ? '' : ` (pid ${String(pid)})`;
};

/**
 * The launchd job's `ProcessType`, appended to the supervisor line: named when it is the one this CLI
 * writes, and a warning with the remedy when it is not — a throttled daemon looks exactly like a slow
 * one from everywhere else, so this line is the only place the cause shows.
 */
function processTypeLine(supervisor: DaemonSupervisorReport, clientName: string): string {
  if (supervisor.processType === undefined) return '';
  if (!launchdThrottled(supervisor)) return `, ProcessType ${LAUNCHD_PROCESS_TYPE}`;
  const declared =
    supervisor.processType === null
      ? 'its launchd job declares no ProcessType'
      : `its launchd job declares ProcessType ${supervisor.processType}`;
  return `\n  macOS is throttling the daemon — run ${clientName} daemon update (${declared}, so macOS limits its CPU and I/O and every agent's with it)`;
}

/** A status that is not `serving` is a failure for a script asking "can I use the daemon?". */
export function statusExitCode(view: DaemonStatusView): number {
  return view.reachability === 'serving' ? 0 : 1;
}

function healthLines(health: HealthView): string[] {
  const bootstrap = health.bootstrapDegraded
    ? `bootstrap ${health.bootstrapState} (degraded)`
    : `bootstrap ${health.bootstrapState}`;
  return [
    `  version ${health.version}   pid ${String(health.pid)}   ${bootstrap}`,
    `  sessions ${String(health.sessions)} (${String(health.running)} running, ${String(health.unmonitoredRunning)} unmonitored)`,
    `  event-loop lag ${health.eventLoopLagMs.toFixed(1)}ms   wedged ${String(health.wedgeCount)}`,
    ...(health.sessionWorkers === undefined
      ? []
      : [`  session workers ${describeSessionWorkerPool(health.sessionWorkers)}`]),
  ];
}

/**
 * Human-readable status.
 *
 * kteam printed raw health JSON and nothing else, so an operator asking whether the daemon was up got
 * a 20-key object and a script got the same thing with no way to ask for either. Here the human form
 * is the default and `--json` is the machine contract.
 */
export function renderDaemonStatus(view: DaemonStatusView, clientName: string): string {
  const supervised =
    view.supervisor.manager === 'direct'
      ? '  not managed by a service manager'
      : `  ${view.supervisor.manager}: ${view.supervisor.state}${view.supervisor.detail === undefined || view.supervisor.detail === '' ? '' : ` (${view.supervisor.detail})`}${processTypeLine(view.supervisor, clientName)}`;

  if (view.reachability === 'serving' && view.health !== undefined) {
    const headline = view.orphan
      ? `${view.daemon} is serving, but OUTSIDE ${view.supervisor.manager} — nothing supervises it`
      : `${view.daemon} is serving`;
    return [headline, ...healthLines(view.health), ...stallLine(view.liveness), supervised].join('\n');
  }
  if (view.reachability === 'starting') {
    const boot = view.liveness?.boot;
    const step =
      boot === undefined
        ? 'its boot step is not reported'
        : `${boot.step}, ${String(boot.stepElapsedSeconds)}s on this step, ${String(boot.elapsedSeconds)}s since it started`;
    const stuck =
      boot !== undefined && boot.stepElapsedSeconds >= STUCK_STEP_SECONDS
        ? [
            `  that step has run for over ${String(STUCK_STEP_SECONDS)}s, which no healthy boot needs: \`${clientName} daemon logs\` shows the trail, and \`${clientName} daemon restart\` starts it again`,
          ]
        : [];
    return [
      `${view.daemon} is starting${pidOf(view)} — ${step}`,
      ...stuck,
      ...stallLine(view.liveness),
      supervised,
    ].join('\n');
  }
  if (view.reachability === 'busy') {
    return [
      `${view.daemon} is up${pidOf(view)} but busy — it answered its liveness check, not its full health report, in time`,
      ...stallLine(view.liveness),
      supervised,
    ].join('\n');
  }
  if (view.reachability === 'wedged') {
    return [
      `${view.daemon} process exists${pidOf(view)} but answered nothing in time — its event loop looks stalled or wedged`,
      `  \`${clientName} daemon logs\` shows the last step and any stall it reported; \`${clientName} daemon restart\` replaces it`,
      supervised,
    ].join('\n');
  }
  return [`${view.daemon} is stopped`, supervised].join('\n');
}

/**
 * The machine-readable shape of `daemon status --json`. `extra` carries the keys another module owns
 * (`install`, `update`), appended after the ones this function decides.
 */
export function renderDaemonStatusJson(view: DaemonStatusView, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify(
    {
      daemon: view.daemon,
      reachability: view.reachability,
      ...(view.liveness === undefined ? {} : { liveness: view.liveness }),
      orphan: view.orphan,
      supervisor: {
        manager: view.supervisor.manager,
        state: view.supervisor.state,
        ...(view.supervisor.pid === undefined ? {} : { pid: view.supervisor.pid }),
        ...(view.supervisor.detail === undefined || view.supervisor.detail === ''
          ? {}
          : { detail: view.supervisor.detail }),
        ...(view.supervisor.processType === undefined
          ? {}
          : { processType: view.supervisor.processType, throttled: launchdThrottled(view.supervisor) }),
      },
      ...(view.health === undefined ? {} : { health: view.health }),
      ...extra,
    },
    null,
    2,
  );
}

/**
 * Reclaimed disk, in the unit a person recognises. One decimal is as much precision as this means.
 *
 * Shared by the two verbs that report disk they took back — retiring the snapshot store an earlier
 * release left, and resetting the installation outright — so the two cannot disagree about what a
 * megabyte is while sitting one screen apart.
 */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

/** Where the daemon's service definition lives, so `install` says what it just wrote. */
export function renderInstalled(daemon: string, definitionPath: string, pid: number | undefined): string {
  const suffix = pid === undefined ? '' : ` (pid ${String(pid)})`;
  return `${daemon} user service installed from ${definitionPath} and started${suffix}`;
}
