import type { Instant } from '@ferretry/std';
import {
  HARNESS_UPDATE_CODES,
  type HarnessCliLocation,
  type HarnessCliView,
  type HarnessInstallMethod,
  type HarnessUpdateStartRequest,
} from '../../../contract/index.ts';
import { readManagerTail } from './manager-tail.ts';
import type { ClaudeLocation, FactsSource, LatestSource, LocationSource, Probe, RunPort, UpdateClock } from './ports.ts';
import {
  CLAUDE_CODE_LABEL,
  type HarnessInstalledVersion,
  type HarnessUpdateJob,
  type HarnessUpdateOutcome,
  type HarnessUpdateReport,
  type UpdateCheck,
  classifyInstall,
  commandLine,
  compareVersions,
  installLabel,
  knownLatestRelease,
  needsUnverifiedConsent,
  type UpdateCommand,
  type UpdateRecipe,
  updatePlan,
  updateRecipe,
  VERIFIED_CLAUDE_CODE_VERSION,
  verification,
  verificationUrl,
} from './recipes.ts';

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
  readonly location: LocationSource;
  readonly facts: FactsSource;
  readonly probe: Probe;
  readonly latest: LatestSource;
  readonly run: RunPort;
  readonly clock: UpdateClock;
  /** Whether npm is asked at all: off for `FY_UPDATE_CHECK=off`, which keeps a suite off the network. */
  readonly checks: boolean;
  readonly timeoutMinutes?: number;
}

/** The route-facing surface. */
export interface HarnessUpdateSubsystem {
  view(): Promise<HarnessCliView>;
  start(request: HarnessUpdateStartRequest): Promise<HarnessCliView>;
}

/** What one look found about one harness, before the job is laid over it. */
interface Snapshot {
  readonly location: ClaudeLocation;
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

const label = CLAUDE_CODE_LABEL;

const locationView = (location: ClaudeLocation): HarnessCliLocation => {
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
 * Updating `claude` on this machine — see `docs/updating.md` › "Updating Claude Code and Codex".
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
  #check: UpdateCheck = { state: 'never' };
  #checking: Promise<UpdateCheck> | undefined;
  #probed: Probed | undefined;
  #job: HarnessUpdateJob | undefined;
  #work: Promise<void> | undefined;

  constructor(options: HarnessUpdateServiceOptions) {
    this.#options = options;
  }

  async view(): Promise<HarnessCliView> {
    const job = this.#job ?? null;
    // While an update runs the binary is being replaced under it: show what was last read.
    const snapshot = await this.#snapshot(false);
    const check = job?.state === 'running' ? this.#check : await this.#checkLatest();
    const installed = versionOf(snapshot.installed);
    const latest = knownLatestRelease(check);
    return {
      harness: 'claude-code',
      location: locationView(snapshot.location),
      installed: snapshot.installed,
      method: snapshot.method,
      plan: snapshot.method === null ? null : updatePlan(snapshot.method, undefined),
      check,
      verified: { version: VERIFIED_CLAUDE_CODE_VERSION, url: verificationUrl(this.#options.product) },
      verification: verification(installed),
      available:
        snapshot.method !== null &&
        latest !== undefined &&
        (installed === undefined || compareVersions(latest.version, installed) === 1),
      job,
    };
  }

  /** Resolves when an update this service started has finished — for a caller that must wait. */
  async settled(): Promise<void> {
    await this.#work;
  }

  async start(request: HarnessUpdateStartRequest): Promise<HarnessCliView> {
    if (this.#job?.state === 'running')
      throw new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, `${label} is already being updated`);
    const snapshot = await this.#snapshot(true);
    if (snapshot.method === null)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notLocated,
        `this daemon cannot find ${label}, so there is nothing to update`,
      );
    const recipe = updateRecipe(snapshot.method, request.target);
    if (recipe.kind === 'manual')
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notSelfUpdatable,
        `Ferretry cannot update ${label} here; follow the steps shown for how it was installed`,
      );
    if (request.target !== undefined && !recipe.pinsVersion)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notTargetable,
        `${installLabel(snapshot.method)} installs the newest ${label} it has and cannot install a chosen version; update without naming one`,
      );
    const from = versionOf(snapshot.installed);
    const latest = knownLatestRelease(await this.#checkLatest())?.version;
    const goal = request.target ?? latest;
    if (from !== undefined && goal !== undefined && compareVersions(goal, from) !== 1)
      throw new HarnessUpdateRefusal(
        HARNESS_UPDATE_CODES.notAvailable,
        request.target === undefined
          ? `${label} ${from} is already the newest version known`
          : `${label} already runs ${from}, which is not older than ${request.target}`,
      );
    const verified = VERIFIED_CLAUDE_CODE_VERSION;
    // A goal nobody could learn may be anything, so it needs the same yes as one known to be unverified.
    if ((goal === undefined || needsUnverifiedConsent(goal)) && request.confirmUnverified !== true)
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
      command: commandLine(recipe.run[0] as UpdateCommand),
    };
    this.#job = running;
    const work = this.#update(snapshot.method, recipe, { from, target: request.target, latest })
      .then(report => {
        this.#job = { state: 'finished', report };
      })
      .finally(() => {
        this.#probed = undefined;
        this.#work = undefined;
      });
    this.#work = work;
    return await this.view();
  }

  /** Where the harness is, what it runs and how it got there. `fresh` skips the short reuse. */
  async #snapshot(fresh: boolean): Promise<Snapshot> {
    const location = await this.#options.location.locate();
    if (location.outcome !== 'located') return { location, installed: null, method: null };
    const probed = await this.#probe(location.path, fresh);
    return { location, installed: probed.installed, method: probed.method };
  }

  async #probe(path: string, fresh: boolean): Promise<Probed> {
    const cached = this.#probed;
    const now = this.#options.clock.now();
    const running = this.#job?.state === 'running';
    if (cached !== undefined && cached.path === path && (running || (!fresh && now - cached.at < HARNESS_PROBE_REUSE_MS)))
      return cached;
    const [installed, facts] = await Promise.all([
      this.#options.probe.version(path),
      this.#options.facts.facts(path),
    ]);
    const probed: Probed = { path, at: now, installed, method: classifyInstall(facts) };
    this.#probed = probed;
    return probed;
  }

  /** The newest version npm knows, asked when the last answer is older than the reuse window. */
  async #checkLatest(): Promise<UpdateCheck> {
    const previous = this.#check;
    const fresh =
      previous.state !== 'never' && this.#options.clock.now() - Date.parse(previous.checkedAt) < HARNESS_CHECK_REUSE_MS;
    if (fresh || !this.#options.checks) return previous;
    const pending =
      this.#checking ??
      this.#refresh(previous).finally(() => {
        this.#checking = undefined;
      });
    this.#checking = pending;
    return await pending;
  }

  async #refresh(previous: UpdateCheck): Promise<UpdateCheck> {
    const answer = await this.#options.latest.latest();
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
    this.#check = next;
    return next;
  }

  /**
   * The program a command is run as. Whether it exists is found by running it: a program that cannot start
   * ends the run with the sentence that says so (the kernel's spawn port reads the host's `PATH`).
   */
  async #program(method: HarnessInstallMethod, command: UpdateCommand): Promise<string> {
    if (command.program === 'harness') {
      const located = await this.#options.location.locate();
      return located.outcome === 'located' ? located.path : 'claude';
    }
    // The npm of the prefix the harness lives in, so an nvm node's global is updated by THAT node's npm.
    if (command.program === 'npm' && method.kind === 'npm-global' && method.prefix !== undefined)
      return `${method.prefix}/bin/npm`;
    return command.program;
  }

  /** Run each command in turn; the first that fails ends the run with its sentence. */
  async #runAll(method: HarnessInstallMethod, commands: readonly UpdateCommand[]): Promise<string | undefined> {
    const timeoutMinutes = this.#options.timeoutMinutes ?? HARNESS_UPDATE_TIMEOUT_MINUTES;
    for (const command of commands) {
      const line = commandLine(command);
      const job = this.#job;
      if (job?.state === 'running') this.#job = { ...job, command: line };
      const result = await this.#options.run({
        program: await this.#program(method, command),
        args: command.args,
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
  async #verify(): Promise<{ readonly version?: string; readonly problem?: string }> {
    const location = await this.#options.location.locate();
    if (location.outcome !== 'located') return { problem: `this daemon can no longer find ${label}` };
    const installed = await this.#options.probe.version(location.path);
    if (installed.state !== 'ok') return { problem: `its --version did not answer (${installed.reason})` };
    const startup = await this.#options.probe.startup(location.path);
    if (!startup.ok) return { version: installed.version, problem: `it did not start (${startup.reason})` };
    return { version: installed.version };
  }

  async #update(
    method: HarnessInstallMethod,
    recipe: Extract<UpdateRecipe, { kind: 'self' }>,
    context: {
      readonly from: string | undefined;
      readonly target: string | undefined;
      readonly latest: string | undefined;
    },
  ): Promise<HarnessUpdateReport> {
    const report = (outcome: HarnessUpdateOutcome, message: string, to?: string): HarnessUpdateReport => ({
      ...(context.from === undefined ? {} : { from: context.from }),
      ...(to === undefined ? {} : { to }),
      ...(context.target === undefined ? {} : { target: context.target }),
      outcome,
      message,
      finishedAt: this.#nowIso(),
    });
    try {
      const failed = await this.#runAll(method, recipe.run);
      const after = await this.#verify();
      const tooOld =
        recipe.pinsVersion &&
        context.target !== undefined &&
        after.version !== undefined &&
        compareVersions(after.version, context.target) === -1;
      const problem =
        after.problem ??
        (failed === undefined && tooOld
          ? `it runs ${after.version ?? ''}, older than the ${context.target ?? ''} asked for`
          : undefined);
      if (problem === undefined && failed === undefined)
        return this.#succeeded(recipe, context, after.version as string, report);
      if (problem === undefined)
        return report(
          'failed',
          `The update did not finish: ${failed ?? ''} ${label} still runs ${after.version ?? 'as before'}.`,
          after.version,
        );
      return await this.#rollBack(
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
    recipe: Extract<UpdateRecipe, { kind: 'self' }>,
    context: {
      readonly from: string | undefined;
      readonly target: string | undefined;
      readonly latest: string | undefined;
    },
    version: string,
    report: (outcome: HarnessUpdateOutcome, message: string, to?: string) => HarnessUpdateReport,
  ): HarnessUpdateReport {
    if (context.from !== undefined && compareVersions(version, context.from) !== 1)
      return report(
        'unchanged',
        `${label} is still ${version}: this install method has nothing newer yet${context.latest === undefined ? '' : ` (npm has ${context.latest})`}.`,
        version,
      );
    const offered = context.target ?? context.latest;
    const newer =
      offered !== undefined && compareVersions(version, offered) === 1
        ? ` (newer than the ${offered} you were offered)`
        : '';
    const behind =
      !recipe.pinsVersion && context.latest !== undefined && compareVersions(version, context.latest) === -1
        ? ` This install method does not have ${context.latest} yet.`
        : '';
    const from = context.from === undefined ? '' : `${context.from} → `;
    return report('succeeded', `Updated ${label} ${from}${version}${newer}.${behind} ${KEEP_RUNNING}`, version);
  }

  async #rollBack(
    method: HarnessInstallMethod,
    recipe: Extract<UpdateRecipe, { kind: 'self' }>,
    context: { readonly from: string | undefined },
    why: string,
    report: (outcome: HarnessUpdateOutcome, message: string, to?: string) => HarnessUpdateReport,
  ): Promise<HarnessUpdateReport> {
    if (recipe.rollback === undefined || context.from === undefined)
      return report(
        'failed',
        `${why} ${recipe.rollback === undefined ? 'This install method keeps no previous version, so Ferretry could not put it back' : `Ferretry did not know which version ran before, so it could not put it back`}; reinstall ${label} with the steps for how it was installed.`,
      );
    const commands = recipe.rollback(context.from);
    const failed = await this.#runAll(method, commands);
    const back = await this.#verify();
    if (failed === undefined && back.problem === undefined && back.version === context.from)
      return report('rolled-back', `${why} ${context.from} was put back, and it starts.`, back.version);
    const manual = commands.map(command => `\`${commandLine(command)}\``).join(', then ');
    return report(
      'failed',
      `${why} Putting ${context.from} back did not work either${failed === undefined ? '' : ` (${failed.replace(/\.$/u, '')})`}; run ${manual} yourself.`,
      back.version,
    );
  }

  #nowIso(): Instant {
    return new Date(this.#options.clock.now()).toISOString() as Instant;
  }
}
