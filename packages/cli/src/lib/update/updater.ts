import {
  classifyInstallMethod,
  compareProtocolVersions,
  describeInstallMethod,
  type InstallMethod,
  type LatestRelease,
  ProtocolVersionSchema,
  planUpdate,
  RELEASE_OWNER,
  releaseTapName,
  releaseTapUrl,
  UPDATE_HEALTH_TIMEOUT_MS,
  type UpdateOutcome,
  type UpdatePlan,
  type UpdateReport,
} from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../daemon/binary.ts';
import type { IClockPort, IDaemonOutput, IDaemonPrompt, IServiceFilePort } from '../daemon/ports.ts';
import { formatElapsed, type IProgress, NO_PROGRESS } from '../progress/index.ts';
import { passMidTurn } from './mid-turn.ts';
import type {
  IDaemonUpdateViewPort,
  IInstallFactsPort,
  ILatestReleasePort,
  IPackageManagerPort,
  IStandaloneReleasePort,
  IUpdateLifecyclePort,
} from './ports.ts';
import { isYes, lastLine, lastLines, type NixProfileSwitch } from './profile-switch.ts';
import { stepObserver } from './step-observer.ts';

/** Flags `fy daemon update` accepts. */
export interface DaemonUpdateOptions {
  /** Report only: what is installed, what is latest, and what updating would take. */
  readonly check?: boolean;
  /** The version to update to; the latest release when absent. */
  readonly to?: string;
  /** Skip the "update now?" confirmation. */
  readonly yes?: boolean;
  /** Wait until no ferret is mid-turn. Without it the update goes ahead: ferrets keep running. */
  readonly whenIdle?: boolean;
  /**
   * Accepted and ignored: it once said "restart even though ferrets are mid-turn", which is now what
   * every update does. Kept so a script or an older daemon's launch that passes it still works.
   */
  readonly anyway?: boolean;
  /** Consent to move a `nix shell` daemon into the nix profile. */
  readonly switchToProfile?: boolean;
  /** Write the outcome here as an `UpdateReport` when finished, whatever it was. */
  readonly report?: string;
  readonly json?: boolean;
}

export interface DaemonUpdaterDeps {
  readonly facts: IInstallFactsPort;
  readonly latest: ILatestReleasePort;
  readonly packages: IPackageManagerPort;
  readonly standalone: IStandaloneReleasePort;
  readonly lifecycle: IUpdateLifecyclePort;
  readonly updateView: IDaemonUpdateViewPort;
  readonly switcher: NixProfileSwitch;
  readonly reports: Pick<IServiceFilePort, 'writePrivate'>;
  readonly out: IDaemonOutput;
  readonly prompt: IDaemonPrompt;
  readonly interactive: () => boolean;
  readonly clock: IClockPort;
  readonly product: string;
  readonly clientName: string;
  readonly daemonName: string;
  /** How long a restarted daemon has to report the target version. */
  readonly healthTimeoutMs?: number;
  /** How often to look again while waiting: for idle, and for the new version. */
  readonly pollMs?: number;
  /** What a long update shows while it works. Absent, it shows nothing. */
  readonly progress?: IProgress;
}

/** Raised for an update refused before anything changed; the message is the whole story. */
class DaemonUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUpdateRefusedError';
  }
}

const DEFAULT_POLL_MS = 1_000;

/** Everything an update decided before it changed anything. */
interface UpdateIntent {
  readonly daemon: InstalledDaemonBinary;
  readonly method: InstallMethod;
  readonly plan: UpdatePlan;
  /** What runs now, or what is installed when nothing runs. */
  readonly current: string;
  readonly target: string;
  readonly running: boolean;
  /** When the command began, for the time the finished update reports. */
  readonly startedAt: number;
}

/** How one method's upgrade went, and how to undo it. */
type Applied =
  | { readonly kind: 'applied'; readonly daemonPath: string; readonly undo: () => Promise<string | undefined> }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * `fy daemon update`: one transaction per install method — check, wait for idle, upgrade with the
 * method's own tool, restart, prove the new version serves, and roll back when it does not.
 *
 * The contract and its reasons are `docs/updating.md`. Two rules shape every branch here:
 *
 * NOTHING CHANGES WITHOUT CONSENT. A terminal is asked; a script passes `--yes`; the daemon, which
 * already asked its person in the app, passes `--yes --anyway`. A `nix shell` daemon additionally needs
 * `--switch-to-profile`, because that switch rewrites the service definition.
 *
 * THE OUTCOME ALWAYS GETS WRITTEN. With `--report`, the file is written on every path that gets past
 * argument parsing — refusals included — because the process the app asked to do this is gone by the
 * time it finishes, and a report that only appears on success reads, to the new daemon, as an update
 * that is still running.
 */
export class DaemonUpdater {
  private readonly healthTimeoutMs: number;
  private readonly pollMs: number;
  private readonly progress: IProgress;

  constructor(private readonly deps: DaemonUpdaterDeps) {
    this.healthTimeoutMs = deps.healthTimeoutMs ?? UPDATE_HEALTH_TIMEOUT_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.progress = deps.progress ?? NO_PROGRESS;
  }

  async update(options: DaemonUpdateOptions): Promise<void> {
    const startedAt = this.deps.clock.now();
    let from = '0.0.0';
    let target = options.to !== undefined && ProtocolVersionSchema.safeParse(options.to).success ? options.to : '0.0.0';
    try {
      const daemon = this.deps.lifecycle.installed();
      this.progress.start('Checking for an update');
      const method = classifyInstallMethod(await this.deps.facts.facts(daemon));
      const plan = planUpdate(method, this.deps);
      const health = await this.deps.lifecycle.probe();
      const current = health?.version ?? daemon.version;
      if (current === undefined) {
        throw new DaemonUpdateRefusedError(`cannot tell which version ${daemon.path} is; it did not answer --version`);
      }
      from = current;
      const latest = await this.#latest(options.to, method);
      this.progress.succeed();
      if (options.check === true) {
        this.#reportCheck(daemon, method, plan, current, latest, options.json === true);
        return;
      }
      if ('failure' in latest) throw new DaemonUpdateRefusedError(latest.failure);
      target = latest.release.version;
      const intent: UpdateIntent = { daemon, method, plan, current, target, running: health !== undefined, startedAt };
      const outcome = await this.#apply(intent, options);
      await this.#finish(options, { from, target, ...outcome });
    } catch (error: unknown) {
      // A refusal and a failure end the same way: one sentence, a non-zero exit, and the report.
      await this.#finish(options, { from, target, outcome: 'failed', message: errorText(error) });
    }
  }

  async #latest(
    to: string | undefined,
    method: InstallMethod,
  ): Promise<{ readonly release: LatestRelease } | { readonly failure: string }> {
    if (to !== undefined) {
      if (!ProtocolVersionSchema.safeParse(to).success) return { failure: `${to} is not a version` };
      return {
        release: { version: to, url: `https://github.com/${RELEASE_OWNER}/${this.deps.product}/releases/tag/v${to}` },
      };
    }
    const answer = await this.deps.latest.latest();
    // A source-built install gets whatever the flake's main is, which is the newest tag, not the newest release.
    const tag =
      method.kind === 'nix-profile' || method.kind === 'nix-shell' ? await this.deps.latest.newestTag() : undefined;
    if (
      tag?.kind === 'found' &&
      (answer.kind === 'failed' || compareProtocolVersions(tag.release.version, answer.release.version) === 1)
    ) {
      return { release: tag.release };
    }
    if (answer.kind === 'failed') return { failure: `could not learn the latest release: ${answer.reason}` };
    return { release: answer.release };
  }

  #reportCheck(
    daemon: InstalledDaemonBinary,
    method: InstallMethod,
    plan: UpdatePlan,
    current: string,
    latest: { readonly release: LatestRelease } | { readonly failure: string },
    json: boolean,
  ): void {
    const release = 'release' in latest ? latest.release : undefined;
    const available = release !== undefined && compareProtocolVersions(release.version, current) === 1;
    if (json) {
      this.deps.out.success(
        JSON.stringify(
          {
            daemon: daemon.path,
            current,
            method,
            plan,
            latest: release ?? null,
            available,
            ...('failure' in latest ? { failure: latest.failure } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    const lines = [`${this.deps.daemonName} ${current}, installed via ${describeInstallMethod(method)}`];
    if (release === undefined) lines.push(`latest: unknown (${'failure' in latest ? latest.failure : ''})`);
    else if (available) lines.push(`update available: ${current} → ${release.version} (${release.url})`);
    else lines.push(`up to date (latest is ${release.version})`);
    lines.push(...renderPlan(plan, this.deps.clientName));
    this.deps.out.success(lines.join('\n'));
  }

  async #apply(
    intent: UpdateIntent,
    options: DaemonUpdateOptions,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    if (compareProtocolVersions(intent.target, intent.current) !== 1)
      return await this.#refreshDefinition(intent, options);
    if (intent.plan.kind === 'manual') {
      throw new DaemonUpdateRefusedError(
        [`${intent.plan.explanation}`, ...renderPlan(intent.plan, this.deps.clientName)].join('\n'),
      );
    }
    if (intent.plan.kind === 'switch' && !(await this.#consentToSwitch(intent.plan.explanation, options))) {
      throw new DaemonUpdateRefusedError(
        [
          intent.plan.explanation,
          ...renderPlan(intent.plan, this.deps.clientName),
          `or run ${this.deps.clientName} daemon update --switch-to-profile`,
        ].join('\n'),
      );
    }
    if (intent.running) await this.#passMidTurn(options);
    await this.#confirm(intent, options);
    const applied = await this.#upgradeStepped(intent, options);
    if (applied.kind === 'failed') return { outcome: 'failed', message: applied.message };
    return await this.#prove(intent, applied);
  }

  async #consentToSwitch(explanation: string, options: DaemonUpdateOptions): Promise<boolean> {
    if (options.switchToProfile === true) return true;
    if (!this.deps.interactive()) return false;
    this.deps.out.warn(explanation);
    return isYes(await this.deps.prompt.ask('Switch to a nix profile install now? [y/N]'));
  }

  /** Ferrets mid-turn keep running through the restart: say so, or wait for idle when asked to. */
  async #passMidTurn(options: DaemonUpdateOptions): Promise<void> {
    await passMidTurn(
      {
        midTurn: () => this.#midTurn(),
        sleep: ms => this.deps.clock.sleep(ms),
        warn: line => this.deps.out.warn(line),
      },
      options.whenIdle === true,
      'updating',
    );
  }

  async #midTurn(): Promise<number> {
    return (await this.deps.updateView.view())?.midTurn ?? 0;
  }

  /**
   * An up-to-date daemon can still be running under a definition that needs rewriting: one written by
   * an older client, then respawned by its manager onto a newer executable, never passes through the
   * restart that would rewrite it. `status` tells that person to run `update`, so `update` is where it
   * is fixed — behind the same consent an update asks for, because the fix is a restart.
   *
   * A daemon that is not running is left alone: the next start rewrites the definition anyway.
   */
  async #refreshDefinition(
    intent: UpdateIntent,
    options: DaemonUpdateOptions,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    const upToDate = `${this.deps.daemonName} ${intent.current} is already up to date`;
    const stale = await this.deps.lifecycle.staleDefinition();
    if (stale === undefined) return { outcome: 'succeeded', message: upToDate };
    if (!intent.running) {
      return { outcome: 'succeeded', message: `${upToDate}; its service definition is rewritten when it next starts` };
    }
    await this.#passMidTurn(options);
    await this.#ask(`Restart ${this.deps.daemonName} to rewrite its service definition (${stale})?`, options);
    await this.deps.lifecycle.restart();
    return {
      outcome: 'succeeded',
      message: `${upToDate}; restarted it under a rewritten service definition (${stale})`,
    };
  }

  async #confirm(intent: UpdateIntent, options: DaemonUpdateOptions): Promise<void> {
    await this.#ask(
      `Update ${this.deps.daemonName} ${intent.current} → ${intent.target} via ${describeInstallMethod(intent.method)}?`,
      options,
    );
  }

  async #ask(question: string, options: DaemonUpdateOptions): Promise<void> {
    if (options.yes === true) return;
    if (!this.deps.interactive())
      throw new DaemonUpdateRefusedError(`${question} Pass --yes to confirm off a terminal`);
    if (!isYes(await this.deps.prompt.ask(`${question} [y/N]`))) {
      throw new DaemonUpdateRefusedError('update cancelled; nothing changed');
    }
  }

  /** The exact commands that recover a Homebrew install by hand, for every message that says it failed. */
  #brewRecovery(cask: string): string {
    const tap = releaseTapName(this.deps.product);
    const client = this.deps.clientName;
    return `To recover by hand run: brew update && brew upgrade --cask ${cask} && ${client} daemon restart; if the tap is wedged: brew untap ${tap} && brew tap ${tap} ${releaseTapUrl(this.deps.product)} && brew reinstall --cask ${cask}`;
  }

  /** `#upgrade`, with its steps settled whichever way it ended. */
  async #upgradeStepped(intent: UpdateIntent, options: DaemonUpdateOptions): Promise<Applied> {
    try {
      const applied = await this.#upgrade(intent, options);
      if (applied.kind === 'applied') this.progress.succeed();
      else this.progress.fail();
      return applied;
    } catch (error: unknown) {
      this.progress.fail();
      throw error;
    }
  }

  /** Run the method's own upgrade. Answers how to undo it, or why it did not happen. */
  async #upgrade(intent: UpdateIntent, options: DaemonUpdateOptions): Promise<Applied> {
    const { method, daemon } = intent;
    const packages = this.deps.packages;
    switch (method.kind) {
      case 'homebrew': {
        const recovery = this.#brewRecovery(method.cask);
        const tap = releaseTapName(this.deps.product);
        if (options.json !== true) {
          this.deps.out.warn(`refreshing the Homebrew tap ${tap} so brew can see ${intent.target} (brew update)`);
        }
        const observe = stepObserver(this.progress, intent.target);
        const refreshed = await packages.brewRefresh(tap, releaseTapUrl(this.deps.product), observe);
        if (refreshed.code !== 0) {
          return failedCommand('brew update', refreshed.stderr, refreshed.code, recovery);
        }
        const outcome = await packages.brewUpgrade(method.cask, observe);
        if (outcome.code !== 0) {
          return failedCommand(`brew upgrade --cask ${method.cask}`, outcome.stderr, outcome.code, recovery);
        }
        return {
          kind: 'applied',
          daemonPath: daemon.path,
          undo: () =>
            Promise.resolve(`Homebrew keeps no previous version, so this could not be rolled back. ${recovery}`),
        };
      }
      case 'nix-profile': {
        const outcome = await packages.nixProfileUpgrade(method.element, stepObserver(this.progress, intent.target));
        if (outcome.code !== 0) {
          return failedCommand(`nix profile upgrade ${method.element}`, outcome.stderr, outcome.code);
        }
        return {
          kind: 'applied',
          daemonPath: daemon.path,
          undo: async () => {
            const back = await packages.nixProfileRollback();
            return back.code === 0
              ? undefined
              : `nix profile rollback failed: ${lastLine(back.stderr) ?? `exit ${String(back.code)}`}`;
          },
        };
      }
      case 'standalone': {
        const staged = await this.deps.standalone.stage(
          intent.target,
          method.directory,
          stepObserver(this.progress, intent.target),
        );
        if ('refused' in staged) return { kind: 'failed', message: staged.refused };
        this.progress.start('Swapping in the new binaries');
        await this.deps.standalone.swap(staged);
        return {
          kind: 'applied',
          daemonPath: daemon.path,
          undo: async () => {
            await this.deps.standalone.rollback(method.directory);
            return undefined;
          },
        };
      }
      default: {
        // Only `nix-shell` reaches here: every other method is `manual`, refused before this.
        this.progress.start('Installing into the nix profile');
        const switched = await this.deps.switcher.install();
        if ('failure' in switched) return { kind: 'failed', message: switched.failure };
        return {
          kind: 'applied',
          daemonPath: switched.path,
          undo: async () => {
            if (intent.running) await this.deps.lifecycle.installAt(daemon.path);
            return undefined;
          },
        };
      }
    }
  }

  /** Prove the target version (or a newer one) is installed and, when a daemon was running, that it serves. */
  async #prove(
    intent: UpdateIntent,
    applied: Extract<Applied, { kind: 'applied' }>,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    const name = this.deps.daemonName;
    const installed = this.deps.lifecycle.versionOf(applied.daemonPath);
    // The package manager may build something newer than the release that was offered; that is still an update.
    const order = installed === undefined ? undefined : compareProtocolVersions(installed, intent.target);
    if (installed === undefined || order === undefined || order < 0) {
      return await this.#rollBack(
        intent,
        applied,
        `the upgrade left ${name} at ${installed ?? 'an unknown version'}, not ${intent.target}`,
      );
    }
    const newer = installed === intent.target ? '' : ` (newer than the ${intent.target} release you were offered)`;
    if (!intent.running) {
      const next =
        applied.daemonPath === intent.daemon.path
          ? `start it with ${this.deps.clientName} daemon start`
          : `run ${this.deps.clientName} daemon install from a new shell to point the service at ${applied.daemonPath}`;
      return { outcome: 'succeeded', message: `${name} updated to ${installed}${newer}; it was not running — ${next}` };
    }
    const failure = await this.#restartInto(intent, applied.daemonPath, installed);
    if (failure !== undefined) return await this.#rollBack(intent, applied, failure);
    const took = formatElapsed(this.deps.clock.now() - intent.startedAt);
    return { outcome: 'succeeded', message: `${name} updated ${intent.current} → ${installed}${newer} in ${took}` };
  }

  /** Restart onto the new executable and wait for it to report the target; answers why not. */
  async #restartInto(intent: UpdateIntent, daemonPath: string, installed: string): Promise<string | undefined> {
    try {
      if (daemonPath === intent.daemon.path) {
        await this.deps.lifecycle.restart({ ferretsKeepRunning: await this.#midTurn() });
      } else await this.deps.lifecycle.installAt(daemonPath);
    } catch (error: unknown) {
      return `the new ${this.deps.daemonName} did not start: ${errorText(error)}`;
    }
    return (await this.#serves(installed))
      ? undefined
      : `the new ${this.deps.daemonName} did not report ${installed} within ${String(Math.round(this.healthTimeoutMs / 1_000))}s`;
  }

  /** Poll `/healthz` until it reports `version`, or the health deadline passes. */
  async #serves(version: string): Promise<boolean> {
    const deadline = this.deps.clock.now() + this.healthTimeoutMs;
    if ((await this.deps.lifecycle.probe())?.version === version) return true;
    this.progress.start(`Waiting for ${this.deps.daemonName} to report ${version}`);
    while (true) {
      if ((await this.deps.lifecycle.probe())?.version === version) {
        this.progress.succeed();
        return true;
      }
      if (this.deps.clock.now() >= deadline) {
        this.progress.fail();
        return false;
      }
      await this.deps.clock.sleep(this.pollMs);
    }
  }

  async #rollBack(
    intent: UpdateIntent,
    applied: Extract<Applied, { kind: 'applied' }>,
    why: string,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    this.progress.start(`Rolling back to ${intent.current}`);
    const cannot = await applied.undo();
    if (cannot !== undefined) {
      return { outcome: 'failed', message: `${why}; ${cannot} — see ${this.deps.clientName} daemon logs` };
    }
    if (!intent.running) {
      return { outcome: 'rolled-back', message: `${why}; ${intent.current} is back in place` };
    }
    try {
      if (applied.daemonPath === intent.daemon.path) await this.deps.lifecycle.restart();
    } catch (error: unknown) {
      return {
        outcome: 'failed',
        message: `${why}; rolled back, but ${intent.current} did not start: ${errorText(error)}`,
      };
    }
    if (!(await this.#serves(intent.current))) {
      return {
        outcome: 'failed',
        message: `${why}; rolled back, but ${intent.current} is not serving — see ${this.deps.clientName} daemon logs`,
      };
    }
    return { outcome: 'rolled-back', message: `${why}; rolled back to ${intent.current}, which is serving` };
  }

  async #finish(
    options: DaemonUpdateOptions,
    result: {
      readonly from: string;
      readonly target: string;
      readonly outcome: UpdateOutcome;
      readonly message: string;
    },
  ): Promise<void> {
    const report: UpdateReport = { ...result, finishedAt: new Date(this.deps.clock.now()).toISOString() };
    if (options.report !== undefined) {
      try {
        await this.deps.reports.writePrivate(options.report, `${JSON.stringify(report, null, 2)}\n`);
      } catch (error: unknown) {
        this.deps.out.warn(`could not write the update report to ${options.report}: ${errorText(error)}`);
      }
    }
    if (report.outcome === 'succeeded') this.progress.succeed();
    else this.progress.fail();
    if (options.json === true) this.deps.out.success(JSON.stringify(report, null, 2));
    else if (report.outcome === 'succeeded') this.deps.out.success(`✔ ${report.message}`);
    else this.deps.out.error(report.message);
    if (report.outcome !== 'succeeded') this.deps.out.setExitCode(1);
  }
}

/** A plan's steps, one line each, for a terminal. */
export function renderPlan(plan: UpdatePlan, clientName: string): string[] {
  if (plan.kind === 'self') return [`to update: ${clientName} daemon update`];
  if (plan.steps.length === 0) return [];
  return [
    'steps:',
    ...plan.steps.map(step => `  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`),
  ];
}

function failedCommand(command: string, stderr: string, code: number, hint?: string): Applied {
  const what = `${command} failed, and nothing changed: ${lastLines(stderr, 3) ?? `exit ${String(code)}`}`;
  return {
    kind: 'failed',
    message: hint === undefined ? what : `${what}. ${hint}`,
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
