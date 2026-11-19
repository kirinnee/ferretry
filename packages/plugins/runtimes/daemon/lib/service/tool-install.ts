/**
 * Installing a harness tool (Claude Code, Codex) on this machine, on an explicit request only.
 *
 * `docs/design/account-model.md` §8.6, §9.6 and edge cases E1 / E2 are the contract. Four properties
 * carry it, and each has exactly one owner here:
 *
 * - **The command comes only from {@link TOOL_PACKAGES}.** A request names a harness, never a package,
 *   a flag or an argument, so nothing a browser sends can become part of what runs. The exact command
 *   is shown before anything runs ({@link ToolInstallService.plans}) and is the same argv that runs.
 * - **The manager is picked from what this machine has**, in the order {@link managerOrder} declares
 *   per system: Homebrew then npm on macOS, apt then npm on Linux, npm elsewhere. A manager is only a
 *   candidate where the table has a package for it, which is how "apt only where a harness publishes
 *   an apt package" is enforced: neither harness does today, so apt is never chosen.
 * - **`sudo` is never run.** A manager that needs admin rights fails, and the failure hands the person
 *   the exact command to run themselves ({@link manualCommand}). The same is true when the machine has
 *   no usable manager at all: the answer is a command for a human, never a guess.
 * - **A caller off this machine needs a live passkey step-up.** The route that serves this declares
 *   `fleet.configure`, and the boundary holds every configure demand from a governed caller behind the
 *   step-up before this service runs.
 *
 * NOTHING HERE RUNS ON ITS OWN. There is no timer, no boot hook and no retry: a package manager starts
 * only inside {@link ToolInstallService.install}, which only a person's explicit request reaches.
 * Afterwards the result is checked with the daemon's one harness resolver (`locateHarnessCommand`), so
 * "installed" means this daemon can now find the tool, not merely that a manager exited zero.
 */
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { HarnessKind } from '../manifest.ts';
import { scrubInstallOutput } from './install-output.ts';
import {
  type ExecutableResolverPort,
  HARNESS_PACKAGES,
  type HarnessLocation,
  stripTerminalEscapes,
} from './foreign.ts';

/** The package managers a harness may be installed through. */
type PackageManager = 'brew' | 'apt' | 'npm';

/**
 * THE declared table: per harness, the arguments each manager is given, after the manager's own name.
 *
 * The package names come from `HARNESS_PACKAGES`, the one place they are spelled, which the harness
 * update (`docs/updating.md`) reads too. Claude Code ships a `claude-code` cask and
 * `@anthropic-ai/claude-code` on npm; Codex ships a `codex` cask and `@openai/codex`. Neither publishes
 * an apt package, so neither has an `apt` entry and apt is never offered — adding one here is the whole
 * change if that ever stops being true.
 */
const TOOL_PACKAGES: Readonly<Record<HarnessKind, Readonly<Partial<Record<PackageManager, readonly string[]>>>>> = {
  claude: {
    brew: ['install', '--cask', HARNESS_PACKAGES.claude.cask],
    npm: ['install', '-g', HARNESS_PACKAGES.claude.npm],
  },
  codex: {
    brew: ['install', '--cask', HARNESS_PACKAGES.codex.cask],
    npm: ['install', '-g', HARNESS_PACKAGES.codex.npm],
  },
};

/**
 * Where each manager usually lives when this daemon's own `PATH` does not say.
 *
 * A daemon started by launchd or systemd inherits a minimal `PATH` (`docs/harness-paths.md`), and
 * Homebrew's prefix is exactly what such a `PATH` leaves out. So after the inherited `PATH`, these
 * absolute paths are asked too. Only stats: nothing is launched to find a manager.
 */
const MANAGER_LOCATIONS: Readonly<Record<PackageManager, readonly string[]>> = {
  brew: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
  apt: ['/usr/bin/apt-get'],
  npm: ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'],
};

/** The program a person types for each manager. apt is driven through `apt-get`, its scriptable front. */
const MANAGER_COMMAND: Readonly<Record<PackageManager, string>> = { brew: 'brew', apt: 'apt-get', npm: 'npm' };

/** Each manager's name as a person reads it in a sentence. */
const MANAGER_NAME: Readonly<Record<PackageManager, string>> = { brew: 'Homebrew', apt: 'apt', npm: 'npm' };

/**
 * Whether a person fixes this manager's "needs admin" by prefixing `sudo`.
 *
 * Homebrew refuses to run as root, so its remedy is the same command in the person's own terminal,
 * where the cask's installer can ask for their password; npm and apt take `sudo`.
 */
const SUDO_REMEDY: Readonly<Record<PackageManager, boolean>> = { brew: false, apt: true, npm: true };

/** Each harness's product name, for sentences. */
const TOOL_NAME: Readonly<Record<HarnessKind, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** How long one install may run before it is stopped. A cask download on a slow link takes minutes. */
const TOOL_INSTALL_TIMEOUT_MINUTES = 15;

/**
 * Lines a manager prints when it needs admin rights it was not given.
 *
 * One list for every manager rather than one per manager: the phrases do not collide, and a manager
 * that borrows another's wording (Homebrew's cask installers print `sudo`'s own refusals) is still read.
 */
const NEEDS_ADMIN = [
  /\bEACCES\b/u,
  /\bEPERM\b/u,
  /permission denied/iu,
  /sudo: (?:a terminal is required|a password is required|no tty present)/iu,
  /need sudo access/iu,
  /are you root\?/iu,
];

/** The manager order this system offers, before the table and the machine narrow it. */
function managerOrder(platform: string): readonly PackageManager[] {
  if (platform === 'darwin') return ['brew', 'npm'];
  if (platform === 'linux') return ['apt', 'npm'];
  return ['npm'];
}

/** A command as a person types it: the manager's name and its declared arguments. */
function display(manager: PackageManager, args: readonly string[]): string {
  return [MANAGER_COMMAND[manager], ...args].join(' ');
}

/** The managers this system offers for this harness, in order, each with its declared arguments. */
function candidates(
  harness: HarnessKind,
  platform: string,
): readonly { readonly manager: PackageManager; readonly args: readonly string[] }[] {
  return managerOrder(platform).flatMap(manager => {
    const args = TOOL_PACKAGES[harness][manager];
    return args === undefined ? [] : [{ manager, args }];
  });
}

/**
 * The command a person runs themselves when this machine could not, for the manager it would have used.
 *
 * Needs-admin is the one case that changes the words: `sudo` for npm and apt, and Homebrew unchanged
 * because it must run as the person, not as root.
 */
function manualCommand(manager: PackageManager, args: readonly string[], needsAdmin: boolean): string {
  const command = display(manager, args);
  return needsAdmin && SUDO_REMEDY[manager] ? `sudo ${command}` : command;
}

/** What installing one harness on this machine would run, decided before anything runs. */
type ToolInstallPlan =
  | {
      readonly harness: HarnessKind;
      readonly kind: 'runnable';
      readonly manager: PackageManager;
      /** The absolute manager executable that will run. */
      readonly executable: string;
      readonly args: readonly string[];
      /** The exact command, as a person reads it. The same arguments as {@link args}. */
      readonly command: string;
    }
  | {
      readonly harness: HarnessKind;
      readonly kind: 'no-package-manager';
      readonly reason: string;
      /** What a person runs once they have the manager this names. */
      readonly manualCommand: string;
    };

/** Find one manager on this machine: the inherited `PATH` first, then its usual locations. */
function locateManager(manager: PackageManager, executables: ExecutableResolverPort): string | undefined {
  return (
    executables.resolve(MANAGER_COMMAND[manager]) ?? MANAGER_LOCATIONS[manager].find(path => executables.runnable(path))
  );
}

/** Decide how one harness would be installed on this machine. Lookups and stats only. */
function planToolInstall(harness: HarnessKind, platform: string, executables: ExecutableResolverPort): ToolInstallPlan {
  const offered = candidates(harness, platform);
  for (const { manager, args } of offered) {
    const executable = locateManager(manager, executables);
    if (executable !== undefined)
      return { harness, kind: 'runnable', manager, executable, args, command: display(manager, args) };
  }
  // Every system offers npm, and every harness has an npm package, so `offered` is never empty.
  const first = offered[0] as { readonly manager: PackageManager; readonly args: readonly string[] };
  const names = offered.map(entry => MANAGER_NAME[entry.manager]).join(' or ');
  return {
    harness,
    kind: 'no-package-manager',
    reason: `${TOOL_NAME[harness]} is installed with ${names}, and this machine has neither; install ${MANAGER_NAME[first.manager]} first, then run the command yourself`,
    manualCommand: manualCommand(first.manager, first.args, false),
  };
}

// ─── the port ──────────────────────────────────────────────────────────────────────────────────────

/** One package-manager run: an absolute executable and its arguments, never a shell string. */
interface PackageInstallRun {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

/**
 * How one run ended. `tail` is the last few lines the manager printed, kept only so a failure can be
 * classified and quoted; it is never stored.
 */
type PackageInstallResult =
  | { readonly kind: 'exited'; readonly code: number; readonly tail: readonly string[] }
  | { readonly kind: 'timed-out'; readonly tail: readonly string[] }
  | { readonly kind: 'not-started'; readonly reason: string };

/** Running one package manager with no stdin, so nothing it asks can wait for an answer. */
export type PackageInstallPort = (run: PackageInstallRun) => Promise<PackageInstallResult>;

// ─── outcomes ──────────────────────────────────────────────────────────────────────────────────────

/** Why one install did not leave a usable tool, so a surface branches on cause rather than on prose. */
type ToolInstallFailureCause =
  | 'no-package-manager'
  | 'needs-admin'
  | 'timed-out'
  | 'could-not-start'
  | 'failed'
  | 'not-found-after-install';

/** How installing one harness ended. */
export type ToolInstallOutcome =
  | { readonly harness: HarnessKind; readonly outcome: 'already-installed'; readonly path: string }
  | {
      readonly harness: HarnessKind;
      readonly outcome: 'installed';
      readonly command: string;
      readonly path: string;
      /** The manager's last lines, scrubbed ({@link scrubInstallOutput}). */
      readonly output: readonly string[];
    }
  | {
      readonly harness: HarnessKind;
      readonly outcome: 'failed';
      readonly cause: ToolInstallFailureCause;
      readonly reason: string;
      /** The exact command for a person to run themselves (E2). */
      readonly manualCommand: string;
      /** The manager's last lines, scrubbed; empty when nothing ran. */
      readonly output: readonly string[];
    };

/** One step of a running install, for a surface that shows progress. */
type ToolInstallProgress =
  | { readonly harness: HarnessKind; readonly stage: 'running'; readonly command: string }
  | { readonly harness: HarnessKind; readonly stage: 'finished'; readonly outcome: ToolInstallOutcome };

/** Whether a manager's last lines say it needed admin rights it was not given. Matched, never shown. */
function readManagerTail(tail: readonly string[]): { readonly needsAdmin: boolean } {
  const lines = tail.map(stripTerminalEscapes);
  return { needsAdmin: lines.some(line => NEEDS_ADMIN.some(pattern => pattern.test(line))) };
}

/** Read how a run ended into an outcome. Pure, so every failure's words are tested without a manager. */
function classifyInstallResult(
  plan: Extract<ToolInstallPlan, { kind: 'runnable' }>,
  result: PackageInstallResult,
  timeoutMinutes: number,
): Extract<ToolInstallOutcome, { outcome: 'failed' }> | undefined {
  const failed = (cause: ToolInstallFailureCause, reason: string, needsAdmin = false) =>
    ({
      harness: plan.harness,
      outcome: 'failed',
      cause,
      reason,
      manualCommand: manualCommand(plan.manager, plan.args, needsAdmin),
      output: result.kind === 'not-started' ? [] : scrubInstallOutput(result.tail),
    }) as const;
  const manager = MANAGER_NAME[plan.manager];
  if (result.kind === 'not-started')
    return failed('could-not-start', `${manager} could not be started here: ${result.reason}`);
  // Classified from the raw lines (a pattern match, never shown); QUOTED only from the scrubbed ones, so a reason can
  // never carry what `output` was scrubbed of.
  const { needsAdmin } = readManagerTail(result.tail);
  const said = scrubInstallOutput(result.tail).at(-1);
  const quoted = said === undefined ? '' : ` It said: ${said}`;
  if (result.kind === 'timed-out')
    return failed(
      'timed-out',
      `${manager} did not finish within ${timeoutMinutes} minutes, so it was stopped.${quoted}`,
    );
  if (result.code === 0) return undefined;
  if (needsAdmin)
    return failed(
      'needs-admin',
      SUDO_REMEDY[plan.manager]
        ? `${manager} needs admin rights and the account this daemon runs as isn't an admin, so nothing was installed. Ferretry never runs sudo; run the command yourself.`
        : `${manager} needs your password to finish installing ${TOOL_NAME[plan.harness]}, and this daemon cannot type one. Run the command in your own terminal.`,
      true,
    );
  return failed('failed', `${manager} stopped with exit code ${result.code}.${quoted}`);
}

/**
 * The environment a manager runs in.
 *
 * Its own directory goes first on `PATH`, because npm is a script whose `#!/usr/bin/env node` must find
 * the node beside it on a daemon whose inherited `PATH` is minimal. `NONINTERACTIVE` is Homebrew's own
 * switch for "never stop to ask".
 */
function installEnvironment(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const directory = executable.slice(0, executable.lastIndexOf('/')) || '/';
  const inherited = environment.PATH;
  return {
    ...environment,
    PATH: inherited === undefined || inherited === '' ? directory : `${directory}:${inherited}`,
    NONINTERACTIVE: '1',
  };
}

// ─── the service ───────────────────────────────────────────────────────────────────────────────────

export type ToolInstallRefusalCode =
  | 'tool_install_unauthorized'
  | 'tool_install_in_progress'
  | 'tool_install_invalid'
  | 'tool_install_plan_changed';

export class ToolInstallRefusal extends Error {
  constructor(
    readonly code: ToolInstallRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolInstallRefusal';
  }
}

interface ToolInstallServiceOptions {
  /** `darwin`, `linux`, … — which managers this system offers; a function when it is learned after boot. */
  readonly platform: string | (() => string);
  /** The daemon's one executable resolver, so manager detection and harness detection agree. */
  readonly executables: ExecutableResolverPort;
  /** The daemon's one harness resolution rule (`locateHarnessCommand`, bound to its policy). */
  readonly locate: (harness: HarnessKind) => HarnessLocation;
  readonly run: PackageInstallPort;
  /**
   * Looks the commands up AFRESH (the managers and the harnesses), past any cached answer. Asked before an install plans
   * and again after the manager ran, so a tool the install just put on this machine is found by the check that follows it.
   */
  readonly refresh?: () => Promise<void>;
  /** The daemon's environment, which a manager inherits with its own directory first on `PATH`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMinutes?: number;
}

/** One request: which harnesses, and the command the person was shown for each (when they were shown one). */
interface ToolInstallRequest {
  readonly harnesses: readonly HarnessKind[];
  readonly shown?: readonly { readonly harness: HarnessKind; readonly command: string }[] | undefined;
}

/** Each harness as it stands before an install: found, or the plan an install would follow. */
export type ToolInstallPreview =
  | { readonly harness: HarnessKind; readonly installed: true; readonly path: string }
  | { readonly harness: HarnessKind; readonly installed: false; readonly plan: ToolInstallPlan };

export class ToolInstallService {
  /** One install at a time: two package managers writing one prefix at once corrupt it. */
  #running = false;

  constructor(private readonly options: ToolInstallServiceOptions) {}

  /** What each named harness is now, and the exact command an install would run. Runs nothing. */
  plans(harnesses: readonly HarnessKind[]): readonly ToolInstallPreview[] {
    return harnesses.map(harness => {
      const located = this.options.locate(harness);
      if (located.outcome === 'located') return { harness, installed: true, path: located.path };
      return {
        harness,
        installed: false,
        plan: planToolInstall(harness, this.#platform(), this.options.executables),
      };
    });
  }

  /**
   * Install the named harnesses, one after another, and say how each ended. The plans are decided ONCE, after the first
   * refresh, checked against what the person was shown, and those same plans run: nothing plans again between check and spawn.
   */
  async install(
    request: ToolInstallRequest,
    governance: CallerGovernance | undefined,
    onProgress: (step: ToolInstallProgress) => void = () => undefined,
  ): Promise<readonly ToolInstallOutcome[]> {
    // Absent governance is refused, not waved through: "nobody can say where this caller stands" is
    // not a reason to run a package manager on the machine.
    if (governance === undefined)
      throw new ToolInstallRefusal(
        'tool_install_unauthorized',
        'this daemon cannot say whether this caller may install software on this machine',
      );
    const harnesses = [...new Set(request.harnesses)];
    if (harnesses.length === 0)
      throw new ToolInstallRefusal('tool_install_invalid', 'name at least one tool to install');
    this.#assertIdle();
    this.#running = true;
    try {
      await this.options.refresh?.();
      // ONE plan per harness, decided here: the plans the person's shown commands are checked against ARE the plans
      // that run. Nothing below plans again, so a refresh after an earlier install cannot change what a later one spawns.
      const checked = this.plans(harnesses);
      this.#assertShownPlans(request.shown ?? [], checked);
      const outcomes: ToolInstallOutcome[] = [];
      for (const preview of checked) {
        const harness = preview.harness;
        const outcome = await this.#installOne(preview, onProgress);
        onProgress({ harness, stage: 'finished', outcome });
        outcomes.push(outcome);
      }
      return outcomes;
    } finally {
      this.#running = false;
    }
  }

  /**
   * The command the person was shown must be the command that would run now. Checked for every harness BEFORE the first
   * one starts, so a changed plan stops the whole request with nothing spawned. A harness that is already installed has
   * no command to compare: it only reports that it is installed.
   */
  #assertShownPlans(
    shown: readonly { readonly harness: HarnessKind; readonly command: string }[],
    checked: readonly ToolInstallPreview[],
  ): void {
    for (const { harness, command } of shown) {
      const preview = checked.find(entry => entry.harness === harness);
      if (preview === undefined || preview.installed) continue;
      const { plan } = preview;
      const fresh = plan.kind === 'runnable' ? plan.command : plan.manualCommand;
      if (fresh !== command)
        throw new ToolInstallRefusal(
          'tool_install_plan_changed',
          `the install command for ${TOOL_NAME[harness]} is not the one that was shown (it is now: ${fresh}); nothing was run. Look at it, then press Install again`,
        );
    }
  }

  /** Run ONE harness's already-checked preview; it never plans, so the command that runs is the one that was checked. */
  async #installOne(
    preview: ToolInstallPreview,
    onProgress: (step: ToolInstallProgress) => void,
  ): Promise<ToolInstallOutcome> {
    const { harness } = preview;
    if (preview.installed) return { harness, outcome: 'already-installed', path: preview.path };
    const { plan } = preview;
    if (plan.kind === 'no-package-manager')
      return {
        harness,
        outcome: 'failed',
        cause: 'no-package-manager',
        reason: plan.reason,
        manualCommand: plan.manualCommand,
        output: [],
      };
    onProgress({ harness, stage: 'running', command: plan.command });
    const timeoutMinutes = this.options.timeoutMinutes ?? TOOL_INSTALL_TIMEOUT_MINUTES;
    const result = await this.options.run({
      executable: plan.executable,
      args: plan.args,
      environment: installEnvironment(plan.executable, this.options.environment),
      timeoutMs: timeoutMinutes * 60_000,
    });
    const failure = classifyInstallResult(plan, result, timeoutMinutes);
    if (failure !== undefined) return failure;
    await this.options.refresh?.();
    const after = this.options.locate(harness);
    if (after.outcome === 'located')
      return {
        harness,
        outcome: 'installed',
        command: plan.command,
        path: after.path,
        output: result.kind === 'exited' ? scrubInstallOutput(result.tail) : [],
      };
    return {
      harness,
      outcome: 'failed',
      cause: 'not-found-after-install',
      reason: `${MANAGER_NAME[plan.manager]} finished, but this daemon still cannot find \`${harness}\`. It was probably installed somewhere outside this daemon's PATH: tell the daemon where it is with FY_${harness.toUpperCase()}_BIN or the harness block in config/daemon.json, then restart it.`,
      manualCommand: plan.command,
      output: result.kind === 'exited' ? scrubInstallOutput(result.tail) : [],
    };
  }

  #platform(): string {
    const { platform } = this.options;
    return typeof platform === 'function' ? platform() : platform;
  }

  #assertIdle(): void {
    if (this.#running)
      throw new ToolInstallRefusal(
        'tool_install_in_progress',
        'an install is already running on this machine; wait for it to finish',
      );
  }
}
