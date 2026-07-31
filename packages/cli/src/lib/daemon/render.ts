import type { HealthView } from '@ferretry/protocol';
import type { DaemonSupervisorReport } from './ports.ts';

/** What `daemon status` concluded, before it is turned into text or JSON. */
export interface DaemonStatusView {
  readonly daemon: string;
  /** `serving`: the HTTP API answered. `unreachable`: a process exists but the API does not answer. */
  readonly reachability: 'serving' | 'unreachable' | 'stopped';
  readonly supervisor: DaemonSupervisorReport;
  readonly health?: HealthView | undefined;
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
): DaemonStatusView {
  if (health !== undefined) return { daemon, reachability: 'serving', supervisor, health };
  const alive = supervisor.state === 'running';
  return { daemon, reachability: alive ? 'unreachable' : 'stopped', supervisor };
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
  ];
}

/**
 * Human-readable status.
 *
 * kteam printed raw health JSON and nothing else, so an operator asking whether the daemon was up got
 * a 20-key object and a script got the same thing with no way to ask for either. Here the human form
 * is the default and `--json` is the machine contract.
 */
export function renderDaemonStatus(view: DaemonStatusView): string {
  const supervised =
    view.supervisor.manager === 'direct'
      ? '  not managed by a service manager'
      : `  ${view.supervisor.manager}: ${view.supervisor.state}${view.supervisor.detail === undefined || view.supervisor.detail === '' ? '' : ` (${view.supervisor.detail})`}`;

  if (view.reachability === 'serving' && view.health !== undefined) {
    return [`${view.daemon} is serving`, ...healthLines(view.health), supervised].join('\n');
  }
  if (view.reachability === 'unreachable') {
    const pid = view.supervisor.pid === undefined ? '' : ` (pid ${String(view.supervisor.pid)})`;
    return [`${view.daemon} process exists${pid} but its API is unavailable`, supervised].join('\n');
  }
  return [`${view.daemon} is stopped`, supervised].join('\n');
}

/** The machine-readable shape of `daemon status --json`. */
export function renderDaemonStatusJson(view: DaemonStatusView): string {
  return JSON.stringify(
    {
      daemon: view.daemon,
      reachability: view.reachability,
      supervisor: {
        manager: view.supervisor.manager,
        state: view.supervisor.state,
        ...(view.supervisor.pid === undefined ? {} : { pid: view.supervisor.pid }),
        ...(view.supervisor.detail === undefined || view.supervisor.detail === ''
          ? {}
          : { detail: view.supervisor.detail }),
      },
      ...(view.health === undefined ? {} : { health: view.health }),
    },
    null,
    2,
  );
}

/** Where the daemon's service definition lives, so `install` says what it just wrote. */
export function renderInstalled(daemon: string, definitionPath: string, pid: number | undefined): string {
  const suffix = pid === undefined ? '' : ` (pid ${String(pid)})`;
  return `${daemon} user service installed from ${definitionPath} and started${suffix}`;
}
