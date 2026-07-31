import type { DaemonSupervisorReport } from './ports.ts';
import type { DaemonLiveness } from './readiness.ts';

/** The fields `systemctl show` is asked for, parsed out of its `key=value` lines. */
export interface SystemdUnitProperties {
  readonly loadState?: string;
  readonly activeState?: string;
  readonly mainPid?: number;
}

/**
 * Parses `systemctl show --property=…` output.
 *
 * Split on the FIRST `=` only and keep the whole remainder. kteam used `split('=', 2)`, which in
 * JavaScript discards everything after the limit rather than keeping it as the final field — a value
 * containing `=` was silently truncated instead of read.
 */
export function parseSystemdProperties(stdout: string): SystemdUnitProperties {
  const properties = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const mainPid = Number(properties.get('MainPID'));
  return {
    ...(properties.has('LoadState') ? { loadState: properties.get('LoadState') } : {}),
    ...(properties.has('ActiveState') ? { activeState: properties.get('ActiveState') } : {}),
    ...(Number.isSafeInteger(mainPid) && mainPid > 1 ? { mainPid } : {}),
  };
}

/**
 * Turns systemd's `ActiveState` into a verdict.
 *
 * `activating` counts as running: the unit is `Type=simple`, so the process already exists and a
 * readiness wait should keep waiting rather than conclude the daemon is down.
 */
export function readSystemdReport(
  properties: SystemdUnitProperties,
  definitionPresent: boolean,
): DaemonSupervisorReport {
  const state = properties.activeState ?? '';
  if (properties.loadState === 'not-found' || (!definitionPresent && state === '')) {
    return { manager: 'systemd', state: 'absent', detail: 'no systemd user unit is installed' };
  }
  const detail = `systemd reports ${state === '' ? 'nothing' : state}`;
  if (state === 'active' || state === 'activating' || state === 'reloading') {
    return {
      manager: 'systemd',
      state: 'running',
      ...(properties.mainPid === undefined ? {} : { pid: properties.mainPid }),
      detail,
    };
  }
  if (state === 'failed') return { manager: 'systemd', state: 'failed', detail };
  return { manager: 'systemd', state: 'stopped', detail };
}

/** The fields worth reading out of `launchctl print`. */
export interface LaunchdJobProperties {
  readonly state?: string;
  readonly pid?: number;
  readonly lastExitStatus?: number;
}

/** Parses the indented `key = value` block `launchctl print` emits. */
export function parseLaunchdPrint(stdout: string): LaunchdJobProperties {
  const field = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'mu').exec(stdout)?.[1];
  const pid = Number(field('pid'));
  const lastExitStatus = Number(field('last exit status'));
  const state = field('state');
  return {
    ...(state === undefined ? {} : { state }),
    ...(Number.isSafeInteger(pid) && pid > 1 ? { pid } : {}),
    ...(Number.isSafeInteger(lastExitStatus) ? { lastExitStatus } : {}),
  };
}

/**
 * Turns a `launchctl print` block into a verdict.
 *
 * kteam reported `running` whenever `launchctl print` merely exited zero — but it exits zero for a
 * loaded job that is throttled, crashed, or waiting, so a daemon stuck in a crash loop reported as
 * running. The job's own `state` field is the answer.
 */
export function readLaunchdReport(
  properties: LaunchdJobProperties,
  definitionPresent: boolean,
): DaemonSupervisorReport {
  const state = properties.state ?? '';
  const detail = `launchd reports ${state === '' ? 'nothing' : state}`;
  if (state === 'running') {
    return {
      manager: 'launchd',
      state: 'running',
      ...(properties.pid === undefined ? {} : { pid: properties.pid }),
      detail,
    };
  }
  if (properties.lastExitStatus !== undefined && properties.lastExitStatus !== 0) {
    return {
      manager: 'launchd',
      state: 'failed',
      detail: `${detail}; last exit status ${String(properties.lastExitStatus)}`,
    };
  }
  if (state === '' && !definitionPresent) {
    return { manager: 'launchd', state: 'absent', detail: 'no launchd user agent is installed' };
  }
  return { manager: 'launchd', state: 'stopped', detail };
}

/** What the supervisor's verdict means to a readiness wait. */
export function livenessOf(report: DaemonSupervisorReport): DaemonLiveness {
  if (report.state === 'running') return 'alive';
  if (report.state === 'failed') return 'dead';
  return 'absent';
}
