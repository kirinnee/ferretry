import {
  classifyInstallMethod,
  type DaemonUpdateView,
  describeInstallMethod,
  type InstallMethod,
  knownLatestRelease,
  type UpdatePlan,
} from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../daemon/binary.ts';
import type { IDaemonUpdateViewPort, IInstallFactsPort } from './ports.ts';

/** What `fy daemon status` adds about installing and updating. */
export interface DaemonUpdateStatus {
  /** How the installed daemon got here; absent when there is no installed daemon to ask about. */
  readonly install: InstallMethod | undefined;
  /** The serving daemon's update view; absent when nothing serves, or it is too old to have one. */
  readonly update: DaemonUpdateView | undefined;
}

/**
 * The install and update lines of `fy daemon status`.
 *
 * The METHOD is classified here, from the executable on this host, so a status works with the daemon
 * down. The UPDATE comes from the daemon, which owns the cached release check — `status` asking GitHub
 * on every invocation would make a local command depend on the network.
 */
export class DaemonUpdateStatusReader {
  constructor(
    private readonly facts: IInstallFactsPort,
    private readonly updateView: IDaemonUpdateViewPort,
  ) {}

  async read(daemon: InstalledDaemonBinary | undefined, serving: boolean): Promise<DaemonUpdateStatus> {
    const install = daemon === undefined ? undefined : classifyInstallMethod(await this.facts.facts(daemon));
    const update = serving ? await this.updateView.view() : undefined;
    return { install, update };
  }
}

/** The human lines, indented to sit under the status headline. */
export function renderUpdateStatus(status: DaemonUpdateStatus, clientName: string): string[] {
  const lines: string[] = [];
  if (status.install !== undefined) lines.push(`  installed via ${describeInstallMethod(status.install)}`);
  const update = status.update;
  const latest = update === undefined ? undefined : knownLatestRelease(update.check);
  if (update?.available === true && latest !== undefined) {
    lines.push(`  update available ${update.current} → ${latest.version} (${latest.url})`);
    lines.push(`  to update: ${nextStep(update.plan, clientName)}`);
  }
  return lines;
}

/** The one command a person runs next for this plan. */
export function nextStep(plan: UpdatePlan, clientName: string): string {
  if (plan.kind === 'self') return `${clientName} daemon update`;
  return plan.steps[0]?.command ?? plan.explanation;
}
