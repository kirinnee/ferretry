import { instantFromEpochMs } from '@ferretry/std';
import {
  serializeUpdateReport,
  classifyInstallMethod,
  compareVersions,
  describeInstallMethod,
  type InstallMethod,
  isNewerMajorVersion,
  isUpdateAvailable,
  type LatestRelease,
  VersionSchema,
  planUpdate,
  RELEASE_OWNER,
  releaseFlakeReference,
  releaseTapName,
  releaseTapUrl,
  UPDATE_HEALTH_TIMEOUT_MS,
  type UpdateOutcome,
  type UpdatePlan,
  type UpdateReport,
} from '@ferretry/plugin-updates/contract';
import type { InstalledDaemonBinary } from './machine.ts';
import type { IClockPort, IDaemonOutput, IDaemonPrompt, IServiceFilePort } from './machine.ts';
import { formatElapsed, type IProgress, NO_PROGRESS } from './progress.ts';
import { MidTurnUnreadableError, passMidTurn } from './mid-turn.ts';
import type {
  IDaemonUpdateViewPort,
  IInstallFactsPort,
  ILatestReleasePort,
  IPackageManagerPort,
  IStandaloneReleasePort,
  IUpdateLifecyclePort,
  LockedNixTarget,
} from './ports.ts';
import { isYes, lastLine, lastLines, type NixProfileSwitch } from './profile-switch.ts';
import { stepObserver } from './step-observer.ts';

/** Flags `fy update` accepts. */
export interface DaemonUpdateOptions {
  /** Report only: what is installed, what is latest, and what updating would take. */
  readonly check?: boolean;
  /** The version to update to; the latest release when absent. */
  readonly to?: string;
  /** Allow a newer major only as part of its migration. `--yes` does not imply this. */
  readonly major?: boolean;
  /** Skip the "update now?" confirmation. */
  readonly yes?: boolean;
  /** Wait until no ferret is mid-turn. Without it the update goes ahead: ferrets keep running. */
  readonly whenIdle?: boolean;
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
  /** The manager metadata bound to this installation, independent of GitHub latest. */
  readonly artifact?: { readonly version: string; readonly nix?: LockedNixTarget };
  /** When the command began, for the time the finished update reports. */
  readonly startedAt: number;
}

/** How one method's upgrade went, and how to undo it. */
type Applied =
  | { readonly kind: 'applied'; readonly daemonPath: string; readonly undo: () => Promise<string | undefined> }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * `fy update`: one transaction per install method — check, wait for idle, upgrade with the
 * method's own tool, restart, prove the new version serves, and roll back when it does not.
 *
 * The contract and its reasons are `docs/updating.md`. Two rules shape every branch here:
 *
 * NOTHING CHANGES WITHOUT CONSENT. A terminal is asked; a script passes `--yes`; the daemon, which
 * already asked its person in the app, passes `--yes`. A `nix shell` daemon additionally needs
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
    let target = options.to !== undefined && VersionSchema.safeParse(options.to).success ? options.to : '0.0.0';
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
      const latest = await this.#latest(options.to);
      this.progress.succeed();
      if (options.check === true) {
        this.#reportCheck(daemon, method, plan, current, latest, options.json === true);
        return;
      }
      if ('failure' in latest) {
        const message =
          this.#cannotPin(method) && options.major !== true && options.to === undefined
            ? this.#managerRefusal(method, current, current, latest.failure)
            : latest.failure;
        throw new DaemonUpdateRefusedError(message);
      }
      target = latest.release.version;
      if (
        method.kind === 'homebrew' &&
        method.cask === `${releaseTapName(this.deps.product)}/${this.deps.product}@4` &&
        (options.major === true || options.to !== undefined) &&
        isNewerMajorVersion('4.0.0', target)
      ) {
        throw new DaemonUpdateRefusedError(
          `The ${this.deps.product}@4 package stays on v4. To move to ${target.split('.').slice(0, 2).join('.')} after preparing the home, run: brew uninstall --cask ${this.deps.product}@4 && brew install --cask ${releaseTapName(this.deps.product)}/${this.deps.product}`,
        );
      }
      let intent: UpdateIntent = { daemon, method, plan, current, target, running: health !== undefined, startedAt };
      // Refuse a known newer major immediately. The @4 cask may still have a v4 patch to offer.
      if (options.to !== undefined || method.kind !== 'homebrew' || !method.cask.endsWith('@4'))
        this.#guardTarget(intent, options);
      if (this.#cannotPin(method) && compareVersions(target, current) === 1) {
        intent = await this.#prepareManager(intent, options);
        target = intent.target;
      }
      const outcome = await this.#apply(intent, options);
      await this.#finish(options, { from, target, ...outcome });
    } catch (error: unknown) {
      // A refusal and a failure end the same way: one sentence, a non-zero exit, and the report.
      await this.#finish(options, { from, target, outcome: 'failed', message: errorText(error) });
    }
  }

  async #latest(to: string | undefined): Promise<{ readonly release: LatestRelease } | { readonly failure: string }> {
    if (to !== undefined) {
      if (!VersionSchema.safeParse(to).success) return { failure: `${to} is not a version` };
      return {
        release: { version: to, url: `https://github.com/${RELEASE_OWNER}/${this.deps.product}/releases/tag/v${to}` },
      };
    }
    const answer = await this.deps.latest.latest();
    if (answer.kind === 'failed') return { failure: `could not learn the latest release: ${answer.reason}` };
    return { release: answer.release };
  }

  #guardTarget(intent: UpdateIntent, options: DaemonUpdateOptions): void {
    if (options.major === true || !isNewerMajorVersion(intent.current, intent.target)) return;
    const reason = this.#majorUpdateMessage(intent.current, intent.target);
    throw new DaemonUpdateRefusedError(
      this.#cannotPin(intent.method)
        ? this.#managerRefusal(intent.method, intent.current, intent.target, reason)
        : reason,
    );
  }

  /** Resolve the exact manager source before any prompts or host installation. */
  async #prepareManager(intent: UpdateIntent, options: DaemonUpdateOptions): Promise<UpdateIntent> {
    const { method } = intent;
    const packages = this.deps.packages;
    let artifact: NonNullable<UpdateIntent['artifact']>;
    if (method.kind === 'homebrew') {
      const tap = releaseTapName(this.deps.product);
      if (options.json !== true)
        this.deps.out.warn(`refreshing the Homebrew tap ${tap} so brew can see ${intent.target} (brew update)`);
      const refreshed = await packages.brewRefresh(
        tap,
        releaseTapUrl(this.deps.product),
        stepObserver(this.progress, intent.target),
      );
      if (refreshed.code !== 0)
        throw new DaemonUpdateRefusedError(
          failedCommand('brew update', refreshed.stderr, refreshed.code, this.#brewRecovery(method.cask)).message,
        );
      const found = await packages.brewCaskVersion(method.cask);
      if ('failure' in found)
        throw new DaemonUpdateRefusedError(this.#managerRefusal(method, intent.current, intent.target, found.failure));
      artifact = found;
    } else {
      const found = await packages.nixResolve(
        releaseFlakeReference(this.deps.product),
        method.kind === 'nix-profile' ? method.element : undefined,
      );
      if ('failure' in found)
        throw new DaemonUpdateRefusedError(this.#managerRefusal(method, intent.current, intent.target, found.failure));
      artifact = { version: found.version, nix: found };
    }
    if (!VersionSchema.safeParse(artifact.version).success)
      throw new DaemonUpdateRefusedError(
        this.#managerRefusal(method, intent.current, intent.target, 'could not parse the package source version'),
      );
    this.#guardTarget({ ...intent, target: artifact.version }, options);
    return { ...intent, artifact, target: options.to === undefined ? artifact.version : intent.target };
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
    const available = isUpdateAvailable(current, release);
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
    else if (isNewerMajorVersion(current, release.version))
      lines.push(this.#majorUpdateMessage(current, release.version));
    else if (available) lines.push(`update available: ${current} → ${release.version} (${release.url})`);
    else lines.push(`up to date (latest is ${release.version})`);
    lines.push(...renderPlan(plan, this.deps.clientName));
    this.deps.out.success(lines.join('\n'));
  }

  async #apply(
    intent: UpdateIntent,
    options: DaemonUpdateOptions,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    this.#guardTarget(intent, options);
    if (compareVersions(intent.target, intent.current) !== 1) return await this.#refreshDefinition(intent, options);
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
          `or run ${this.deps.clientName} update --switch-to-profile`,
        ].join('\n'),
      );
    }
    if (intent.running) await this.#passMidTurn(options);
    await this.#confirm(intent, options);
    const applied = await this.#upgradeStepped(intent, options);
    if (applied.kind === 'failed') return { outcome: 'failed', message: applied.message };
    return await this.#prove(intent, applied, options);
  }

  #cannotPin(method: InstallMethod): boolean {
    return method.kind === 'homebrew' || method.kind === 'nix-profile' || method.kind === 'nix-shell';
  }

  #managerRefusal(method: InstallMethod, current: string, target: string, reason: string): string {
    const major = current.split('.')[0];
    const safeTarget = isNewerMajorVersion(current, target) ? current : target;
    // Only v4 has a pinned cask (`${product}@4`); a later major has none, so Homebrew names no way back.
    const route =
      method.kind === 'homebrew'
        ? major === '4'
          ? `brew install --cask ${releaseTapName(this.deps.product)}/${this.deps.product}@4`
          : undefined
        : `nix profile install github:${RELEASE_OWNER}/${this.deps.product}/v${safeTarget}`;
    const stays = reason.includes(`Your daemon stays on ${current}.`) ? '' : ` Your daemon stays on ${current}.`;
    const tail = route === undefined ? '' : ` To stay on v${major}, run: ${route}`;
    return `${reason}${reason.endsWith('.') ? '' : '.'}${stays}${tail}`;
  }

  #majorUpdateMessage(current: string, target: string): string {
    const notes = `https://github.com/${RELEASE_OWNER}/${this.deps.product}/releases/tag/v${target}`;
    return `${target} is the next major version, not a plain update: it comes with its own steps. Read that release's notes first: ${notes}. Your daemon stays on ${current}. --major allows the move.`;
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
        midTurn: async () => {
          // Only asked while the daemon is up: a view that is not there is a count that could not be read.
          const view = await this.deps.updateView.view();
          if (view === undefined) throw new MidTurnUnreadableError();
          return view.midTurn;
        },
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
    this.#guardRestart(intent, intent.daemon.path, options);
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
        // Consent / --when-idle may have waited. Read local metadata again, never refresh it here.
        const found = await packages.brewCaskVersion(method.cask);
        if ('failure' in found)
          throw new DaemonUpdateRefusedError(
            this.#managerRefusal(method, intent.current, intent.target, found.failure),
          );
        this.#guardTarget({ ...intent, target: found.version }, options);
        if (found.version !== intent.artifact?.version)
          throw new DaemonUpdateRefusedError(
            'the local Homebrew cask changed while waiting; no upgrade or restart ran. Run the update again',
          );
        const observe = stepObserver(this.progress, intent.target);
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
        const outcome = await packages.nixProfileUpgrade(
          method.element,
          intent.artifact?.nix,
          stepObserver(this.progress, intent.target),
        );
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
        const switched = await this.deps.switcher.install(intent.artifact?.nix, true);
        if ('failure' in switched) return { kind: 'failed', message: switched.failure };
        return {
          kind: 'applied',
          daemonPath: switched.path,
          undo: async () => {
            if (intent.running) {
              this.#guardRestart(intent, daemon.path, options);
              await this.deps.lifecycle.installAt(daemon.path);
            }
            return undefined;
          },
        };
      }
    }
  }

  #guardRestart(intent: UpdateIntent, path: string, options: DaemonUpdateOptions): void {
    const installed = this.#guardInstalled(intent, path, options);
    if (installed === undefined || !VersionSchema.safeParse(installed).success)
      throw new DaemonUpdateRefusedError(`cannot read the installed version at ${path}; refusing to restart`);
  }

  /** Check fresh executable bytes immediately before every restart, including definition repair. */
  #guardInstalled(intent: UpdateIntent, path: string, options: DaemonUpdateOptions): string | undefined {
    const installed = this.deps.lifecycle.versionOf(path);
    if (installed !== undefined && options.major !== true && isNewerMajorVersion(intent.current, installed)) {
      // Only v4 has a pinned cask (`${product}@4`); for a later major Homebrew keeps no way back, so name the release.
      const pinned = intent.current.split('.')[0] === '4';
      const recovery =
        intent.method.kind === 'homebrew'
          ? pinned
            ? `brew uninstall --cask ${this.deps.product} && brew install --cask ${releaseTapName(this.deps.product)}/${this.deps.product}@4 && ${this.deps.clientName} daemon restart`
            : `brew uninstall --cask ${this.deps.product}, then install ${intent.current} again from https://github.com/${RELEASE_OWNER}/${this.deps.product}/releases/tag/v${intent.current} and run ${this.deps.clientName} daemon restart`
          : intent.method.kind === 'nix-profile' || intent.method.kind === 'nix-shell'
            ? 'nix profile rollback'
            : 'restore the previous binaries';
      throw new DaemonUpdateRefusedError(
        `The installed ${this.deps.daemonName} is ${installed}, a newer major than ${intent.current}. No restart ran; ${intent.running ? 'the running daemon was left up' : 'the daemon remains stopped'}. Recover with: ${recovery}. --major allows this move.`,
      );
    }
    return installed;
  }

  /** Prove the judged artifact is installed and, when a daemon was running, that it serves. */
  async #prove(
    intent: UpdateIntent,
    applied: Extract<Applied, { kind: 'applied' }>,
    options: DaemonUpdateOptions,
  ): Promise<Omit<UpdateReport, 'from' | 'target' | 'finishedAt'>> {
    const name = this.deps.daemonName;
    const installed = this.#guardInstalled(intent, applied.daemonPath, options);
    // Managers must deliver the judged version; standalone releases retain the same-major >= target rule.
    const order = installed === undefined ? undefined : compareVersions(installed, intent.target);
    if (
      installed === undefined ||
      order === undefined ||
      order < 0 ||
      (intent.artifact !== undefined && installed !== intent.artifact.version)
    ) {
      return await this.#rollBack(
        intent,
        applied,
        `the upgrade left ${name} at ${installed ?? 'an unknown version'}, not ${intent.artifact?.version ?? intent.target}`,
        options,
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
    const failure = await this.#restartInto(intent, applied.daemonPath, installed, options);
    if (failure !== undefined) return await this.#rollBack(intent, applied, failure, options);
    const took = formatElapsed(this.deps.clock.now() - intent.startedAt);
    return { outcome: 'succeeded', message: `${name} updated ${intent.current} → ${installed}${newer} in ${took}` };
  }

  /** Restart onto the new executable and wait for it to report the target; answers why not. */
  async #restartInto(
    intent: UpdateIntent,
    daemonPath: string,
    installed: string,
    options: DaemonUpdateOptions,
  ): Promise<string | undefined> {
    try {
      if (daemonPath === intent.daemon.path) {
        const ferretsKeepRunning = await this.#midTurn();
        this.#guardRestart(intent, daemonPath, options);
        await this.deps.lifecycle.restart({ ferretsKeepRunning });
      } else {
        this.#guardRestart(intent, daemonPath, options);
        await this.deps.lifecycle.installAt(daemonPath);
      }
    } catch (error: unknown) {
      if (error instanceof DaemonUpdateRefusedError) throw error;
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
    options: DaemonUpdateOptions,
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
      if (applied.daemonPath === intent.daemon.path) {
        this.#guardRestart(intent, applied.daemonPath, options);
        await this.deps.lifecycle.restart();
      }
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
    const report: UpdateReport = { ...result, finishedAt: instantFromEpochMs(this.deps.clock.now()) };
    if (options.report !== undefined) {
      try {
        await this.deps.reports.writePrivate(options.report, serializeUpdateReport(report));
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
  if (plan.kind === 'self') return [`to update: ${clientName} update`];
  if (plan.steps.length === 0) return [];
  return [
    'steps:',
    ...plan.steps.map(step => `  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`),
  ];
}

function failedCommand(
  command: string,
  stderr: string,
  code: number,
  hint?: string,
): Extract<Applied, { kind: 'failed' }> {
  const what = `${command} failed, and nothing changed: ${lastLines(stderr, 3) ?? `exit ${String(code)}`}`;
  return {
    kind: 'failed',
    message: hint === undefined ? what : `${what}. ${hint}`,
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
