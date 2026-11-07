import { describeInstallMethod, type InstallMethodKind, knownLatestRelease } from '@ferretry/protocol';
import type { DaemonInspection } from '../daemon/controller.ts';
import type { DaemonReachability } from '../daemon/render.ts';
import { nextStep } from '../update/status.ts';
import type { RelayReach } from './ports.ts';

/** What `fy setup` will do to the daemon, decided from an inspection alone. */
export type DaemonPlan = 'none' | 'install' | 'start' | 'missing';

/**
 * The one decision that makes `fy setup` safe to run twice: a daemon already serving under the
 * service manager is left alone. A daemon serving as a stray child on a host that has a service
 * manager is installed, because supervision is what setup is for — `install` hands the stray over.
 */
export function planDaemon(inspection: DaemonInspection): DaemonPlan {
  const { view, located, serviceManager } = inspection;
  if (view.reachability === 'serving') {
    const supervised = view.supervisor.manager !== 'direct' && !view.orphan;
    return supervised || !serviceManager ? 'none' : 'install';
  }
  // A daemon that is booting or busy is UP: installing or starting another over it would only fight it
  // for the state home's lock. The summary reports the state and `status` says what it is doing.
  if (view.reachability === 'starting' || view.reachability === 'busy') return 'none';
  if ('reason' in located) return 'missing';
  return serviceManager ? 'install' : 'start';
}

/** What happened to the daemon during this run. */
export type DaemonAction =
  | 'none'
  | 'installed'
  | 'started'
  | 'would-install'
  | 'would-start'
  | 'declined'
  | 'needs-terminal'
  | 'failed';

/** One command the person (or their agent) runs next. */
interface SetupNextStep {
  readonly command: string;
  readonly why: string;
  /**
   * Run it in a terminal of your own, never through an agent: it asks questions, or it shows a
   * pairing code, which must not land in a transcript.
   */
  readonly ownTerminal: boolean;
}

/** Whether the pairing QR is offered at the end of this run, or left as a next step. */
export type PairingOffer = 'now' | 'later';

/** Everything `fy setup` found, in the shape `--json` prints. It has no field for a code or a token. */
export interface SetupSummary {
  readonly schema: 1;
  readonly ready: boolean;
  /** 0 ready, 1 not ready, 2 waiting for a person: refused off a terminal, or declined. */
  readonly exitCode: 0 | 1 | 2;
  readonly client: { readonly version: string };
  readonly install: { readonly method: InstallMethodKind; readonly description: string } | null;
  readonly daemon: {
    readonly state: DaemonReachability | 'not-installed';
    readonly action: DaemonAction;
    readonly version: string | null;
    readonly installedVersion: string | null;
    readonly manager: string;
    readonly supervised: boolean;
    readonly problem: string | null;
  };
  readonly update: {
    readonly available: boolean;
    readonly current: string;
    readonly latest: string | null;
    readonly command: string | null;
  } | null;
  readonly relay: RelayReach;
  readonly machine: { readonly setUp: boolean | null };
  readonly warnings: readonly string[];
  readonly next: readonly SetupNextStep[];
}

export interface SummaryInput {
  readonly clientVersion: string;
  readonly clientName: string;
  readonly inspection: DaemonInspection;
  readonly action: DaemonAction;
  readonly problem: string | undefined;
  readonly relay: RelayReach;
  readonly setUp: boolean | undefined;
  readonly pairing: PairingOffer;
}

const PENDING: ReadonlySet<DaemonAction> = new Set(['declined', 'needs-terminal']);

/** Decide the summary. Pure: every fact it reads was gathered before it was called. */
export function summarize(input: SummaryInput): SetupSummary {
  const bin = input.clientName;
  const { view, located, update } = input.inspection;
  const serving = view.reachability === 'serving';
  const health = view.health;
  const installedVersion = 'reason' in located ? null : (located.version ?? null);
  const install = update?.install;
  const daemonUpdate = update?.update;
  const latest = daemonUpdate === undefined ? undefined : knownLatestRelease(daemonUpdate.check);
  const updateCommand =
    daemonUpdate?.available === true && latest !== undefined ? nextStep(daemonUpdate.plan, bin) : null;

  const warnings: string[] = [];
  const next: SetupNextStep[] = [];
  if (serving && health !== undefined) {
    if (installedVersion !== null && installedVersion !== health.version) {
      warnings.push(`The running daemon is ${health.version} but ${installedVersion} is installed.`);
      next.push({ command: `${bin} daemon restart`, why: 'run the installed version', ownTerminal: false });
    }
    if (health.version !== input.clientVersion)
      warnings.push(`${bin} is ${input.clientVersion} but the daemon is ${health.version}.`);
    if (install?.kind === 'nix-shell')
      warnings.push('Installed from a temporary nix shell, which garbage collection can delete.');
    if (input.pairing === 'later') next.push({ command: `${bin} pair`, why: 'pair your phone', ownTerminal: true });
    if (input.setUp === false)
      next.push({ command: `${bin} daemon setup`, why: 'use your Claude Code and Codex logins', ownTerminal: true });
    if (updateCommand !== null)
      next.push({ command: updateCommand, why: `update to ${latest?.version ?? 'the latest'}`, ownTerminal: false });
  } else if (input.action === 'needs-terminal') {
    next.push({ command: `${bin} setup --yes`, why: 'install and start the daemon', ownTerminal: false });
  } else if (input.action === 'declined' || input.action === 'would-install' || input.action === 'would-start') {
    next.push({ command: `${bin} setup`, why: 'install and start the daemon', ownTerminal: false });
  } else if (input.action === 'failed' && !('reason' in located)) {
    next.push({ command: `${bin} daemon logs`, why: 'see why the daemon did not start', ownTerminal: false });
  }

  const pending = PENDING.has(input.action);
  return {
    schema: 1,
    ready: serving,
    exitCode: pending ? 2 : serving ? 0 : 1,
    client: { version: input.clientVersion },
    install: install === undefined ? null : { method: install.kind, description: describeInstallMethod(install) },
    daemon: {
      state: !serving && 'reason' in located ? 'not-installed' : view.reachability,
      action: input.action,
      version: health?.version ?? null,
      installedVersion,
      manager: view.supervisor.manager,
      supervised: serving && view.supervisor.manager !== 'direct' && !view.orphan,
      problem: input.problem ?? ('reason' in located && !serving ? located.reason : null),
    },
    update:
      daemonUpdate === undefined
        ? null
        : {
            available: updateCommand !== null,
            current: daemonUpdate.current,
            latest: latest?.version ?? null,
            command: updateCommand,
          },
    relay: input.relay,
    machine: { setUp: input.setUp ?? null },
    warnings,
    next,
  };
}

const OK = '✓';
const AGENDA = '!';

/** One aligned status row. */
const row = (ok: boolean, label: string, text: string): string => `  ${ok ? OK : AGENDA} ${label.padEnd(9)}${text}`;

function daemonRow(summary: SetupSummary): string {
  const daemon = summary.daemon;
  if (daemon.state === 'serving') {
    const how = daemon.supervised ? `, started by ${daemon.manager}` : ', not supervised';
    return row(true, 'Daemon', `running ${daemon.version ?? ''}${how}`);
  }
  const why: Record<DaemonAction, string> = {
    none: daemon.state,
    installed: daemon.state,
    started: daemon.state,
    'would-install': 'not running — setup would install it as a user service',
    'would-start': 'not running — setup would start it',
    declined: 'not running — you skipped installing it',
    'needs-terminal': 'not running — add --yes to install it without questions',
    failed: 'did not start',
  };
  const text = daemon.problem === null ? why[daemon.action] : `${why[daemon.action]}: ${daemon.problem}`;
  return row(false, 'Daemon', text);
}

function relayRow(relay: RelayReach): string {
  if (relay.state === 'relay') return row(true, 'Relay', 'on — your phone can connect from any network');
  if (relay.state === 'direct-only') return row(false, 'Relay', 'off — your phone must be on the same network');
  return row(false, 'Relay', `could not check (${relay.reason})`);
}

/**
 * The human report: a handful of aligned rows, then numbered next steps. Short on purpose — this is
 * what somebody reads right after installing, often relayed by an agent, so every row is one line.
 */
export function renderSetupSummary(summary: SetupSummary): string {
  const lines = [summary.ready ? 'Ferretry is set up.' : 'Ferretry is not running yet.', '', daemonRow(summary)];
  if (summary.install !== null) lines.push(row(true, 'Install', summary.install.description));
  if (summary.update !== null) {
    lines.push(
      summary.update.available
        ? row(false, 'Update', `${summary.update.latest ?? ''} is available (you have ${summary.update.current})`)
        : row(true, 'Update', 'up to date'),
    );
  }
  if (summary.ready) {
    lines.push(relayRow(summary.relay));
    if (summary.machine.setUp !== null)
      lines.push(
        summary.machine.setUp
          ? row(true, 'Agents', 'set up')
          : row(false, 'Agents', 'not set up yet — no Claude Code or Codex runtime'),
      );
  }
  for (const warning of summary.warnings) lines.push(row(false, 'Note', warning));
  if (summary.next.length > 0) {
    const width = Math.max(...summary.next.map(step => step.command.length));
    lines.push('', 'Next:');
    summary.next.forEach((step, index) => {
      const where = step.ownTerminal ? ' — in your own terminal' : '';
      lines.push(`  ${String(index + 1)}. ${step.command.padEnd(width)}   ${step.why}${where}`);
    });
  }
  return lines.join('\n');
}

/** The `--json` contract. A versioned object, so an agent can branch on `ready` and read `next`. */
export function renderSetupSummaryJson(summary: SetupSummary): string {
  return JSON.stringify(summary, null, 2);
}
