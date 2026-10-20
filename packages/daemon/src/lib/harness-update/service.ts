import {
  classifyHarnessInstall,
  compareProtocolVersions,
  HARNESS_CLI_LABELS,
  HARNESS_UPDATE_CODES,
  type Harness,
  type HarnessCliLocation,
  type HarnessCliView,
  type HarnessCommand,
  type HarnessInstalledVersion,
  type HarnessInstallMethod,
  type HarnessUpdateJob,
  type HarnessUpdateOutcome,
  type HarnessUpdateRecipe,
  type HarnessUpdateReport,
  type HarnessUpdateStartRequest,
  type HarnessUpdateView,
  harnessCommandLine,
  harnessInstallLabel,
  harnessUpdatePlan,
  harnessUpdateRecipe,
  harnessVerification,
  harnessVerificationUrl,
  knownLatestRelease,
  needsUnverifiedConsent,
  type UpdateCheck,
  VERIFIED_HARNESS_VERSIONS,
} from '@ferretry/protocol';
import type { ExecutableResolverPort, HarnessLocation } from '../core/harness-readiness.ts';
import { installEnvironment, locateManager, type PackageInstallPort, readManagerTail } from '../fleet/tool-install.ts';
import type { UpdateClock } from '../update/ports.ts';
import type { HarnessFactsSource, HarnessLatestSource, HarnessProbe } from './ports.ts';

/** The harnesses, in the order every surface lists them. */
const HARNESSES: readonly Harness[] = ['claude', 'codex'];

/**
 * How long one answer from npm is reused. Long enough that the panel's own re-reads while an update
 * runs, and a `fy harness status` straight after opening Settings, ask once; short enough that opening
 * Settings again later asks again. There is NO timer: an answer is only ever asked for by a look.
 */
export const HARNESS_CHECK_REUSE_MS = 5 * 60_000;

/** How long a binary's `--version` answer is reused between looks. */
export const HARNESS_PROBE_REUSE_MS = 30_000;

/** How long one update command may run. A cask download or a nix build on a slow link takes minutes. */
const HARNESS_UPDATE_TIMEOUT_MINUTES = 15;

/** Why a start was refused, with the code the app says the right sentence for. */
export class HarnessUpdateRefusal extends Error {
  constructor(
    readonly code: (typeof HARNESS_UPDATE_CODES)[keyof typeof HARNESS_UPDATE_CODES],
    message: string,
    /** For `harness_update_unverified`: what would be installed, and what Ferretry verified. */
    readonly unverified?: { readonly target?: string; readonly verified: string },
  ) {
    super(message);
    this.name = 'HarnessUpdateRefusal';
  }
}

export interface HarnessUpdateServiceOptions {
  /** The product name, for the verification link. */
  readonly product: string;
  readonly homeDirectory: string;
  /** The daemon's ONE harness resolution rule (`locateHarnessCommand` bound to its policy). */
  readonly locate: (harness: Harness) => HarnessLocation;
  readonly facts: HarnessFactsSource;
  readonly probe: HarnessProbe;
  readonly latest: HarnessLatestSource;
  /** The daemon's one executable resolver, so finding `npm` here and in the tool install agree. */
  readonly executables: ExecutableResolverPort;
  readonly run: PackageInstallPort;
  /** The daemon's environment, which a manager inherits with its own directory first on `PATH`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clock: UpdateClock;
  /** Whether npm is asked at all: off for `FY_UPDATE_CHECK=off`, which keeps a suite off the network. */
  readonly checks: boolean;
  readonly timeoutMinutes?: number;
}

/** The route-facing surface. */
export interface HarnessUpdateSubsystem {
  view(): Promise<HarnessUpdateView>;
  start(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView>;
}

/** What one look found about one harness, before the job is laid over it. */
interface Snapshot {
  readonly location: HarnessLocation;
  readonly installed: HarnessInstalledVersion | null;
  readonly method: HarnessInstallMethod | null;
}

interface Probed {
  readonly path: string;
  readonly at: number;
  readonly installed: HarnessInstalledVersion;
  readonly method: HarnessInstallMethod;
}

type Running = Extract<HarnessUpdateJob, { state: 'running' }>;

const locationView = (location: HarnessLocation): HarnessCliLocation => {
  if (location.outcome === 'located')
    return { state: 'located', path: location.path, rule: location.rule, declaredBy: location.declaredBy };
  if (location.outcome === 'override-absent')
    return { state: 'override-absent', path: location.path, declaredBy: location.declaredBy, reason: location.reason };
  return { state: 'absent', searched: [...location.searched] };
};

const versionOf = (installed: HarnessInstalledVersion | null): string | undefined =>
  installed?.state === 'ok' ? installed.version : undefined;

/** Running ferrets are not restarted by an update, and a sentence about one always says so. */
const KEEP_RUNNING =
  'Running ferrets keep the version they started with until they are restarted; new ones start on this one.';

/**
 * Updating `claude` and `codex` on this machine — see `docs/updating.md` › "Updating Claude Code and Codex".
 *
 * NOTHING HERE RUNS ON ITS OWN. There is no timer and no boot hook: npm is asked for the newest version
 * only inside {@link view}, which only somebody looking reaches, and a package manager runs only inside
 * {@link start}, which only a person's explicit request reaches. Past the version Ferretry verified,
 * that request must also carry their explicit yes.
 *
 * Unlike the daemon's own update this runs IN-PROCESS: replacing a harness restarts nothing, so there
 * is no restart to outlive. A ferret already running keeps the binary it started with.
 */
export class HarnessUpdateService implements HarnessUpdateSubsystem {
  readonly #options: HarnessUpdateServiceOptions;
  readonly #checks = new Map<Harness, UpdateCheck>();
  readonly #checking = new Map<Harness, Promise<UpdateCheck>>();
  readonly #probed = new Map<Harness, Probed>();
  readonly #jobs = new Map<Harness, HarnessUpdateJob>();
  readonly #work = new Map<Harness, Promise<void>>();

  constructor(options: HarnessUpdateServiceOptions) {
    this.#options = options;
  }

  async view(): Promise<HarnessUpdateView> {
    return { harnesses: await Promise.all(HARNESSES.map(async harness => await this.#harnessView(harness))) };
  }

  /** Resolves when every update this service started has finished — for a caller that must wait. */
  async settled(): Promise<void> {
    await Promise.all([...this.#work.values()]);
  }

  async start(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> {
    const { harness } = request;
    const label = HARNESS_CLI_LABELS[harness];
    if (this.#jobs.get(harness)?.state === 'running')
      throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, `${label} is already being updated`);
    const snapshot = await this.#snapshot(harness, true);
    if (snapshot.method === null)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notLocated,
        `this daemon cannot find ${label}, so there is nothing to update`,
      );
    const recipe = harnessUpdateRecipe(harness, snapshot.method, request.target);
    if (recipe.kind === 'manual')
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notSelfUpdatable,
        `Ferretry cannot update ${label} here; follow the steps shown for how it was installed`,
      );
    if (request.target !== undefined && !recipe.pinsVersion)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notTargetable,
        `${harnessInstallLabel(snapshot.method)} installs the newest ${label} it has and cannot install a chosen version; update without naming one`,
      );
    const from = versionOf(snapshot.installed);
    const latest = knownLatestRelease(await this.#check(harness))?.version;
    const goal = request.target ?? latest;
    if (from !== undefined && goal !== undefined && compareProtocolVersions(goal, from) !== 1)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notAvailable,
        request.target === undefined
          ? `${label} ${from} is already the newest version known`
          : `${label} already runs ${from}, which is not older than ${request.target}`,
      );
    const verified = VERIFIED_HARNESS_VERSIONS[harness];
    // A goal nobody could learn may be anything, so it needs the same yes as one known to be unverified.
    if ((goal === undefined || needsUnverifiedConsent(harness, goal)) && request.confirmUnverified !== true)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.unverified,
        goal === undefined
          ? `Ferretry could not learn which ${label} version this would install, so it may be one Ferretry has not verified (verified: ${verified}); confirm to go ahead`
          : `${label} ${goal} has not been verified by Ferretry yet (verified: ${verified}); confirm to go past it`,
        { ...(goal === undefined ? {} : { target: goal }), verified },
      );
    const running: Running = {
      state: 'running',
      ...(request.target === undefined ? {} : { target: request.target }),
      startedAt: this.#nowIso(),
      command: harnessCommandLine(harness, recipe.run[0] as HarnessCommand),
    };
    this.#jobs.set(harness, running);
    const work = this.#update(harness, snapshot.method, recipe, { from, target: request.target, latest })
      .then(report => {
        this.#jobs.set(harness, { state: 'finished', report });
      })
      .finally(() => {
        this.#probed.delete(harness);
        this.#work.delete(harness);
      });
    this.#work.set(harness, work);
    return await this.view();
  }

  async #harnessView(harness: Harness): Promise<HarnessCliView> {
    const job = this.#jobs.get(harness) ?? null;
    // While an update runs the binary is being replaced under it: show what was last read.
    const snapshot = await this.#snapshot(harness, false);
    const check =
      job?.state === 'running' ? (this.#checks.get(harness) ?? { state: 'never' }) : await this.#check(harness);
    const installed = versionOf(snapshot.installed);
    const latest = knownLatestRelease(check);
    return {
      harness,
      location: locationView(snapshot.location),
      installed: snapshot.installed,
      method: snapshot.method,
      plan: snapshot.method === null ? null : harnessUpdatePlan(harness, snapshot.method, undefined),
      check,
      verified: { version: VERIFIED_HARNESS_VERSIONS[harness], url: harnessVerificationUrl(this.#options.product) },
      verification: harnessVerification(harness, installed),
      available:
        snapshot.method !== null &&
        latest !== undefined &&
        (installed === undefined || compareProtocolVersions(latest.version, installed) === 1),
      job,
    };
  }

  /** Where the harness is, what it runs and how it got there. `fresh` skips the short reuse. */
  async #snapshot(harness: Harness, fresh: boolean): Promise<Snapshot> {
    const location = this.#options.locate(harness);
    if (location.outcome !== 'located') return { location, installed: null, method: null };
    const probed = await this.#probe(harness, location.path, fresh);
    return { location, installed: probed.installed, method: probed.method };
  }

  async #probe(harness: Harness, path: string, fresh: boolean): Promise<Probed> {
    const cached = this.#probed.get(harness);
    const now = this.#options.clock.now();
    const running = this.#jobs.get(harness)?.state === 'running';
    if (
      cached !== undefined &&
      cached.path === path &&
      (running || (!fresh && now - cached.at < HARNESS_PROBE_REUSE_MS))
    )
      return cached;
    const [installed, facts] = await Promise.all([
      this.#options.probe.version(path),
      this.#options.facts.facts(harness, path),
    ]);
    const probed: Probed = { path, at: now, installed, method: classifyHarnessInstall(facts) };
    this.#probed.set(harness, probed);
    return probed;
  }

  /** The newest version npm knows, asked when the last answer is older than the reuse window. */
  async #check(harness: Harness): Promise<UpdateCheck> {
    const previous = this.#checks.get(harness) ?? { state: 'never' };
    const fresh =
      previous.state !== 'never' && this.#options.clock.now() - Date.parse(previous.checkedAt) < HARNESS_CHECK_REUSE_MS;
    if (fresh || !this.#options.checks) return previous;
    const pending =
      this.#checking.get(harness) ??
      this.#refresh(harness, previous).finally(() => {
        this.#checking.delete(harness);
      });
    this.#checking.set(harness, pending);
    return await pending;
  }

  async #refresh(harness: Harness, previous: UpdateCheck): Promise<UpdateCheck> {
    const answer = await this.#options.latest.latest(harness);
    const checkedAt = this.#nowIso();
    let next: UpdateCheck;
    if (answer.kind === 'ok') next = { state: 'ok', checkedAt, latest: answer.release };
    else {
      const carried =
        previous.state === 'ok'
          ? { checkedAt: previous.checkedAt, latest: previous.latest }
          : previous.state === 'failed'
            ? previous.lastKnown
            : undefined;
      next = {
        state: 'failed',
        checkedAt,
        reason: answer.reason,
        ...(carried === undefined ? {} : { lastKnown: carried }),
      };
    }
    this.#checks.set(harness, next);
    return next;
  }

  /** The executable a program is run as, or `undefined` when this machine has none this daemon can see. */
  #executable(harness: Harness, method: HarnessInstallMethod, command: HarnessCommand): string | undefined {
    const { executables, homeDirectory } = this.#options;
    const home = homeDirectory.replace(/\/+$/u, '');
    const first = (candidates: readonly string[]): string | undefined =>
      candidates.find(path => executables.runnable(path));
    switch (command.program) {
      case 'harness': {
        const located = this.#options.locate(harness);
        return located.outcome === 'located' ? located.path : undefined;
      }
      case 'npm': {
        // The npm of the prefix the harness lives in, so an nvm node's global is updated by THAT node's npm.
        const prefix = method.kind === 'npm-global' ? method.prefix : undefined;
        return (prefix === undefined ? undefined : first([`${prefix}/bin/npm`])) ?? locateManager('npm', executables);
      }
      case 'brew':
        return locateManager('brew', executables);
      case 'nix':
        return (
          executables.resolve('nix') ??
          first([
            `${home}/.nix-profile/bin/nix`,
            '/nix/var/nix/profiles/default/bin/nix',
            '/run/current-system/sw/bin/nix',
          ])
        );
      case 'pnpm':
        return executables.resolve('pnpm') ?? first([`${home}/.local/share/pnpm/pnpm`, `${home}/Library/pnpm/pnpm`]);
      case 'bun':
        return executables.resolve('bun') ?? first([`${home}/.bun/bin/bun`]);
      case 'volta':
        return executables.resolve('volta') ?? first([`${home}/.volta/bin/volta`]);
    }
  }

  /** Run each command in turn; the first that fails ends the run with its sentence. */
  async #runAll(
    harness: Harness,
    method: HarnessInstallMethod,
    commands: readonly HarnessCommand[],
  ): Promise<string | undefined> {
    const timeoutMinutes = this.#options.timeoutMinutes ?? HARNESS_UPDATE_TIMEOUT_MINUTES;
    for (const command of commands) {
      const line = harnessCommandLine(harness, command);
      const executable = this.#executable(harness, method, command);
      if (executable === undefined)
        return `this daemon cannot find \`${line.split(' ')[0] ?? ''}\` on its PATH; run \`${line}\` yourself.`;
      const job = this.#jobs.get(harness);
      if (job?.state === 'running') this.#jobs.set(harness, { ...job, command: line });
      const result = await this.#options.run({
        executable,
        args: command.args,
        environment: installEnvironment(executable, this.#options.environment),
        timeoutMs: timeoutMinutes * 60_000,
      });
      if (result.kind === 'not-started') return `\`${line}\` could not be started: ${result.reason}`;
      const { needsAdmin, said } = readManagerTail(result.tail);
      const quoted = said === undefined ? '' : ` It said: ${said}`;
      if (result.kind === 'timed-out') return `\`${line}\` did not finish within ${timeoutMinutes} minutes.${quoted}`;
      if (result.code === 0) continue;
      if (needsAdmin)
        return `\`${line}\` needs admin rights this daemon does not have, and Ferretry never runs sudo; run it yourself.`;
      return `\`${line}\` stopped with exit code ${result.code}.${quoted}`;
    }
    return undefined;
  }

  /** The new binary's version, and whether it starts. A failure is the sentence that says why. */
  async #verify(harness: Harness): Promise<{ readonly version?: string; readonly problem?: string }> {
    const location = this.#options.locate(harness);
    if (location.outcome !== 'located')
      return { problem: `this daemon can no longer find ${HARNESS_CLI_LABELS[harness]}` };
    const installed = await this.#options.probe.version(location.path);
    if (installed.state !== 'ok') return { problem: `its --version did not answer (${installed.reason})` };
    const startup = await this.#options.probe.startup(location.path);
    if (!startup.ok) return { version: installed.version, problem: `it did not start (${startup.reason})` };
    return { version: installed.version };
  }

  async #update(
    harness: Harness,
    method: HarnessInstallMethod,
    recipe: Extract<HarnessUpdateRecipe, { kind: 'self' }>,
    context: {
      readonly from: string | undefined;
      readonly target: string | undefined;
      readonly latest: string | undefined;
    },
  ): Promise<HarnessUpdateReport> {
    const label = HARNESS_CLI_LABELS[harness];
    const report = (outcome: HarnessUpdateOutcome, message: string, to?: string): HarnessUpdateReport => ({
      ...(context.from === undefined ? {} : { from: context.from }),
      ...(to === undefined ? {} : { to }),
      ...(context.target === undefined ? {} : { target: context.target }),
      outcome,
      message,
      finishedAt: this.#nowIso(),
    });
    try {
      const failed = await this.#runAll(harness, method, recipe.run);
      const after = await this.#verify(harness);
      const tooOld =
        recipe.pinsVersion &&
        context.target !== undefined &&
        after.version !== undefined &&
        compareProtocolVersions(after.version, context.target) === -1;
      const problem =
        after.problem ??
        (failed === undefined && tooOld
          ? `it runs ${after.version ?? ''}, older than the ${context.target ?? ''} asked for`
          : undefined);
      if (problem === undefined && failed === undefined)
        return this.#succeeded(harness, recipe, context, after.version as string, report);
      if (problem === undefined)
        return report(
          'failed',
          `The update did not finish: ${failed ?? ''} ${label} still runs ${after.version ?? 'as before'}.`,
          after.version,
        );
      return await this.#rollBack(
        harness,
        method,
        recipe,
        context,
        `${failed === undefined ? '' : `${failed} `}After the update ${problem}.`,
        report,
      );
    } catch (error) {
      return report('failed', `The update stopped: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  #succeeded(
    harness: Harness,
    recipe: Extract<HarnessUpdateRecipe, { kind: 'self' }>,
    context: {
      readonly from: string | undefined;
      readonly target: string | undefined;
      readonly latest: string | undefined;
    },
    version: string,
    report: (outcome: HarnessUpdateOutcome, message: string, to?: string) => HarnessUpdateReport,
  ): HarnessUpdateReport {
    const label = HARNESS_CLI_LABELS[harness];
    if (context.from !== undefined && compareProtocolVersions(version, context.from) !== 1)
      return report(
        'unchanged',
        `${label} is still ${version}: this install method has nothing newer yet${context.latest === undefined ? '' : ` (npm has ${context.latest})`}.`,
        version,
      );
    const offered = context.target ?? context.latest;
    const newer =
      offered !== undefined && compareProtocolVersions(version, offered) === 1
        ? ` (newer than the ${offered} you were offered)`
        : '';
    const behind =
      !recipe.pinsVersion && context.latest !== undefined && compareProtocolVersions(version, context.latest) === -1
        ? ` This install method does not have ${context.latest} yet.`
        : '';
    const from = context.from === undefined ? '' : `${context.from} → `;
    return report('succeeded', `Updated ${label} ${from}${version}${newer}.${behind} ${KEEP_RUNNING}`, version);
  }

  async #rollBack(
    harness: Harness,
    method: HarnessInstallMethod,
    recipe: Extract<HarnessUpdateRecipe, { kind: 'self' }>,
    context: { readonly from: string | undefined },
    why: string,
    report: (outcome: HarnessUpdateOutcome, message: string, to?: string) => HarnessUpdateReport,
  ): Promise<HarnessUpdateReport> {
    const label = HARNESS_CLI_LABELS[harness];
    if (recipe.rollback === undefined || context.from === undefined)
      return report(
        'failed',
        `${why} ${recipe.rollback === undefined ? 'This install method keeps no previous version, so Ferretry could not put it back' : `Ferretry did not know which version ran before, so it could not put it back`}; reinstall ${label} with the steps for how it was installed.`,
      );
    const commands = recipe.rollback(context.from);
    const failed = await this.#runAll(harness, method, commands);
    const back = await this.#verify(harness);
    if (failed === undefined && back.problem === undefined && back.version === context.from)
      return report('rolled-back', `${why} ${context.from} was put back, and it starts.`, back.version);
    const manual = commands.map(command => `\`${harnessCommandLine(harness, command)}\``).join(', then ');
    return report(
      'failed',
      `${why} Putting ${context.from} back did not work either${failed === undefined ? '' : ` (${failed.replace(/\.$/u, '')})`}; run ${manual} yourself.`,
      back.version,
    );
  }

  #nowIso(): string {
    return new Date(this.#options.clock.now()).toISOString();
  }
}
