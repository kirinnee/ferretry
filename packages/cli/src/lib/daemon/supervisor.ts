import { dirname, resolve } from 'node:path';
import type { DaemonLayout } from './layout.ts';
import type {
  DaemonStartHandle,
  DaemonSupervisorReport,
  IDaemonProcessPort,
  IDaemonSupervisor,
  IServiceDefinitionSupervisor,
  IServiceFilePort,
  IStateHomeClaimPort,
  StopRequest,
} from './ports.ts';
import { parseLaunchdPrint, parseSystemdProperties, readLaunchdReport, readSystemdReport } from './probe.ts';
import {
  launchAgentProcessType,
  launchAgentStateHome,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  systemdUnitStateHome,
} from './unit-file.ts';

/** Raised when a verb needs a service manager this host does not have. */
export class UnsupportedServiceManagerError extends Error {
  constructor() {
    super('service install supports launchd on macOS and systemd user services on Linux');
    this.name = 'UnsupportedServiceManagerError';
  }
}

/** Raised when a service-manager command fails; carries whatever it said. */
export class ServiceManagerCommandError extends Error {
  constructor(argv: readonly string[], stderr: string) {
    super(stderr.trim() === '' ? `${argv.join(' ')} failed` : stderr.trim());
    this.name = 'ServiceManagerCommandError';
  }
}

/**
 * Raised when a lifecycle verb would act on a daemon it cannot tie to the state home it was asked
 * about. Nothing has been stopped, signalled or rewritten when this is thrown.
 */
export class DaemonOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonOwnershipError';
  }
}

/**
 * Throw unless `pid` provably serves `layout`'s state home, by holding that home's daemon lock open.
 *
 * A pid that answered a health probe is a NUMBER somebody sent over HTTP. A forwarded container port,
 * a second installation on the default address or a daemon in another pid namespace all report a pid
 * that names some unrelated local process here — and signalling it, then escalating to SIGKILL, is
 * the defect this exists to prevent. The lock is held for the daemon's whole life and by nothing else,
 * so it is the one identity none of those can share.
 *
 * `allowUnknown` is for a caller that will never signal the pid itself: a service manager stops its
 * own unit, so a host that cannot answer the question costs that caller nothing. A `false` is refused
 * by every caller, because a daemon that is provably someone else's must not be stopped or reset.
 */
async function assertPidServes(
  processes: IDaemonProcessPort,
  layout: DaemonLayout,
  pid: number,
  allowUnknown: boolean,
): Promise<void> {
  const holds = await processes.holdsOpen(pid, layout.daemonLockFile);
  if (holds === true || (holds === undefined && allowUnknown)) return;
  if (holds === false) {
    throw new DaemonOwnershipError(
      `the daemon answering for ${layout.stateHome} reports pid ${String(pid)}, but that process does not hold ` +
        `${layout.daemonLockFile}, so it is not this state home's ${layout.daemonName} — it may be a forwarded ` +
        `port, a container or another installation; nothing was signalled. Stop that daemon where it runs`,
    );
  }
  throw new DaemonOwnershipError(
    `cannot check which state home pid ${String(pid)} serves: this host offers neither /proc nor lsof, so ` +
      `nothing was signalled. Stop ${layout.daemonName} from the terminal it runs in, or check it with ` +
      `\`ps -p ${String(pid)}\` and end it with \`kill ${String(pid)}\` yourself`,
  );
}

/**
 * Throw unless the installed service definition supervises `layout`'s state home.
 *
 * ONE UNIT NAME PER HOST, whatever `FY_HOME` says: `fyd.service` and `com.ferretry.fyd` are spelled
 * from the daemon name alone. So `FY_HOME=/other fy daemon reset` used to stop the PRIMARY daemon's
 * unit and `start` used to rewrite it to serve `/other`. The definition is the only record of which
 * home it supervises, so it is read back; one that names none was not written by this CLI and is
 * refused rather than guessed about.
 */
async function assertDefinitionServes(
  files: IServiceFilePort,
  layout: DaemonLayout,
  definitionPath: string,
  stateHomeOf: (definition: string) => string | undefined,
): Promise<void> {
  const definition = await files.read(definitionPath);
  if (definition === undefined) return;
  const supervised = stateHomeOf(definition);
  if (supervised === undefined) {
    throw new DaemonOwnershipError(
      `${definitionPath} names no FY_HOME, so it cannot be tied to ${layout.stateHome}; it was not written by ` +
        `this client — remove it, then install again`,
    );
  }
  if (resolve(supervised) === resolve(layout.stateHome)) return;
  throw new DaemonOwnershipError(
    `${definitionPath} supervises the ${layout.daemonName} for ${supervised}, not ${layout.stateHome}, and there ` +
      `is one per host; nothing was changed. Run this again with FY_HOME=${supervised} to manage that daemon, ` +
      `or uninstall it that way first to supervise ${layout.stateHome} instead`,
  );
}

/** The description both service definitions carry. */
const description = (daemonName: string): string => `${daemonName} — per-host agent daemon`;

/**
 * Claim the state home, then create the log directory inside it.
 *
 * ORDER MATTERS AND IS THE POINT. `<state home>/logs` is the first thing this CLI ever puts inside
 * the daemon's home, and it goes in before the daemon has run once — so an unclaimed home reaches
 * the daemon already non-empty, which is the arrangement it must refuse. Claiming first means the
 * marker is there before the directory is, and every ordering of `fy` and `fyd` works the same way.
 *
 * The daemon still tolerates a lone unclaimed `logs/` in its pre-bootstrap shape, and that allowance
 * must stay: an older `fy` on this same host creates one without claiming, and refusing those hosts
 * is the very failure this removes.
 */
async function claimThenCreateLogDirectory(
  claims: IStateHomeClaimPort,
  files: IServiceFilePort,
  layout: DaemonLayout,
): Promise<void> {
  await claims.claim(layout.stateHome);
  await files.ensureDirectory(layout.logDirectory);
}

/** Drives a systemd user unit. */
export class SystemdSupervisor implements IServiceDefinitionSupervisor {
  readonly manager = 'systemd' as const;

  constructor(
    private readonly layout: DaemonLayout,
    private readonly processes: IDaemonProcessPort,
    private readonly files: IServiceFilePort,
    private readonly claims: IStateHomeClaimPort,
  ) {}

  /** Where systemd reads this unit from, so an installer can name the file it wrote. */
  get definitionPath(): string {
    return this.layout.systemdUnitFile;
  }

  async installed(): Promise<boolean> {
    return await this.files.exists(this.definitionPath);
  }

  async install(executable: string): Promise<void> {
    await this.#refresh(executable);
    await this.#require(['enable', this.layout.systemdUnitName]);
    await this.#require(['restart', this.layout.systemdUnitName]);
  }

  async #refresh(executable: string): Promise<void> {
    await this.files.ensureDirectory(dirname(this.layout.systemdUnitFile));
    await claimThenCreateLogDirectory(this.claims, this.files, this.layout);
    await this.files.writePrivate(
      this.layout.systemdUnitFile,
      renderSystemdUnit({
        daemonBinary: executable,
        stateHome: this.layout.stateHome,
        userHome: this.layout.homeDirectory,
        logFile: this.layout.logFile,
        searchPath: this.layout.searchPath,
        locale: this.layout.locale,
        description: description(this.layout.daemonName),
      }),
    );
    await this.#require(['daemon-reload']);
  }

  async uninstall(): Promise<void> {
    // A `disable --now` on an already-absent unit is a non-zero no-op, so it is tolerated on purpose.
    await this.#systemctl(['disable', '--now', this.layout.systemdUnitName]);
    await this.files.remove(this.layout.systemdUnitFile);
    await this.#require(['daemon-reload']);
  }

  async start(executable: string): Promise<DaemonStartHandle> {
    await this.#refresh(executable);
    await this.#require(['start', this.layout.systemdUnitName]);
    return {};
  }

  /**
   * `systemctl --user restart`, after the definition is rewritten for `executable`.
   *
   * One command rather than a stop this CLI watches and a start it issues: systemd then owns the whole
   * transition, escalates a stuck stop under its own timeout, and never has a window in which the unit
   * is down and something else can start a daemon beside it.
   */
  async restartInPlace(executable: string): Promise<void> {
    await this.#refresh(executable);
    await this.#require(['restart', this.layout.systemdUnitName]);
  }

  async stop(request: StopRequest): Promise<void> {
    await this.#require(
      request.escalate
        ? ['kill', '--signal=SIGKILL', this.layout.systemdUnitName]
        : ['stop', this.layout.systemdUnitName],
    );
  }

  async assertServes(pidHint: number | undefined): Promise<void> {
    await assertDefinitionServes(this.files, this.layout, this.definitionPath, systemdUnitStateHome);
    if (pidHint !== undefined) await assertPidServes(this.processes, this.layout, pidHint, true);
  }

  async inspect(): Promise<DaemonSupervisorReport> {
    const present = await this.installed();
    const outcome = await this.#systemctl([
      'show',
      this.layout.systemdUnitName,
      '--property=LoadState',
      '--property=ActiveState',
      '--property=MainPID',
    ]);
    if (outcome.code !== 0) {
      return { manager: 'systemd', state: present ? 'stopped' : 'absent', detail: outcome.stderr.trim() };
    }
    return readSystemdReport(parseSystemdProperties(outcome.stdout), present);
  }

  async #systemctl(args: readonly string[]): ReturnType<IDaemonProcessPort['run']> {
    return await this.processes.run(['systemctl', '--user', ...args]);
  }

  async #require(args: readonly string[]): Promise<void> {
    const outcome = await this.#systemctl(args);
    if (outcome.code !== 0) throw new ServiceManagerCommandError(['systemctl', '--user', ...args], outcome.stderr);
  }
}

/** Drives a launchd user agent. */
export class LaunchdSupervisor implements IServiceDefinitionSupervisor {
  readonly manager = 'launchd' as const;

  constructor(
    private readonly layout: DaemonLayout,
    private readonly processes: IDaemonProcessPort,
    private readonly files: IServiceFilePort,
    private readonly claims: IStateHomeClaimPort,
  ) {}

  /** Where launchd reads this agent from, so an installer can name the file it wrote. */
  get definitionPath(): string {
    return this.layout.launchAgentFile;
  }

  async installed(): Promise<boolean> {
    return await this.files.exists(this.definitionPath);
  }

  async install(executable: string): Promise<void> {
    await this.#reload(executable);
  }

  /** Rewrite and reload: launchd caches ProgramArguments from bootstrap, not from the plist path. */
  async #reload(executable: string): Promise<void> {
    await this.#writeDefinition(executable);
    // An unloaded job cannot be booted out, so this failure is expected and ignored.
    await this.processes.run(['launchctl', 'bootout', this.layout.launchdServiceTarget]);
    await this.#require(['bootstrap', this.layout.launchdDomain, this.layout.launchAgentFile]);
  }

  async #writeDefinition(executable: string): Promise<void> {
    await this.files.ensureDirectory(dirname(this.layout.launchAgentFile));
    await claimThenCreateLogDirectory(this.claims, this.files, this.layout);
    await this.files.writePrivate(
      this.layout.launchAgentFile,
      renderLaunchAgentPlist({
        label: this.layout.launchdLabel,
        daemonBinary: executable,
        stateHome: this.layout.stateHome,
        userHome: this.layout.homeDirectory,
        logFile: this.layout.logFile,
        searchPath: this.layout.searchPath,
        locale: this.layout.locale,
        description: description(this.layout.daemonName),
      }),
    );
  }

  async uninstall(): Promise<void> {
    await this.processes.run(['launchctl', 'bootout', this.layout.launchdServiceTarget]);
    await this.files.remove(this.layout.launchAgentFile);
  }

  async start(executable: string): Promise<DaemonStartHandle> {
    await this.#reload(executable);
    return {};
  }

  async stop(request: StopRequest): Promise<void> {
    await this.#require(
      request.escalate
        ? ['kill', 'SIGKILL', this.layout.launchdServiceTarget]
        : ['bootout', this.layout.launchdServiceTarget],
    );
  }

  async assertServes(pidHint: number | undefined): Promise<void> {
    await assertDefinitionServes(this.files, this.layout, this.definitionPath, launchAgentStateHome);
    if (pidHint !== undefined) await assertPidServes(this.processes, this.layout, pidHint, true);
  }

  /**
   * The job's state, and — read from the plist rather than from `launchctl print`, whose wording is not
   * a contract — the `ProcessType` it declares, so `status` can say when macOS is throttling it.
   */
  async inspect(): Promise<DaemonSupervisorReport> {
    const present = await this.installed();
    const plist = present ? await this.files.read(this.definitionPath) : undefined;
    const declared = plist === undefined ? {} : { processType: launchAgentProcessType(plist) ?? null };
    const outcome = await this.processes.run(['launchctl', 'print', this.layout.launchdServiceTarget]);
    if (outcome.code !== 0) {
      return { manager: 'launchd', state: present ? 'stopped' : 'absent', detail: outcome.stderr.trim(), ...declared };
    }
    return { ...readLaunchdReport(parseLaunchdPrint(outcome.stdout), present), ...declared };
  }

  async #require(args: readonly string[]): Promise<void> {
    const outcome = await this.processes.run(['launchctl', ...args]);
    if (outcome.code !== 0) throw new ServiceManagerCommandError(['launchctl', ...args], outcome.stderr);
  }
}

/**
 * Runs the daemon as a plain detached child, for a host with no service manager and for an operator
 * who has not installed one.
 *
 * Nothing here reads a pid file. kteam's stop read `paths.pid`, signalled whatever it found, and then
 * deleted the file whether or not the kill worked — so a failed stop left `status` claiming the daemon
 * was down while it was still serving. The pid comes from the daemon's own health response instead,
 * which cannot be stale, and the readiness wait watches the child this invocation actually spawned.
 */
export class DirectSupervisor implements IDaemonSupervisor {
  readonly manager = 'direct' as const;

  constructor(
    private readonly layout: DaemonLayout,
    private readonly processes: IDaemonProcessPort,
    private readonly files: IServiceFilePort,
    private readonly claims: IStateHomeClaimPort,
  ) {}

  installed(): Promise<boolean> {
    return Promise.resolve(false);
  }

  install(_executable: string): Promise<void> {
    return Promise.reject(new UnsupportedServiceManagerError());
  }

  uninstall(): Promise<void> {
    return Promise.reject(new UnsupportedServiceManagerError());
  }

  async start(executable: string): Promise<DaemonStartHandle> {
    await claimThenCreateLogDirectory(this.claims, this.files, this.layout);
    return await this.processes.spawnDetached({
      argv: [executable],
      // `HOME` is the home this CLI resolved, so the daemon looks for harness logins where `fy` does
      // rather than in whichever home the user database names.
      environment: {
        FY_HOME: this.layout.stateHome,
        HOME: this.layout.homeDirectory,
        PATH: this.layout.searchPath,
        ...this.layout.locale,
      },
      logFile: this.layout.logFile,
    });
  }

  /**
   * Signal the daemon, but only once its pid is proved to serve this state home.
   *
   * Checked HERE, on every press including the escalation, rather than trusted from the controller:
   * this is the one place a pid that arrived over HTTP turns into a SIGKILL, so it is the place that
   * has to be unable to send one to a stranger. A host that cannot answer refuses too, because there
   * is no service manager behind this to stop the right thing instead.
   */
  async stop(request: StopRequest): Promise<void> {
    if (request.pidHint === undefined) return;
    await this.assertServes(request.pidHint);
    this.processes.signal(request.pidHint, request.escalate ? 'SIGKILL' : 'SIGTERM');
  }

  async assertServes(pidHint: number | undefined): Promise<void> {
    if (pidHint !== undefined) await assertPidServes(this.processes, this.layout, pidHint, false);
  }

  inspect(handle?: DaemonStartHandle): Promise<DaemonSupervisorReport> {
    const pid = handle?.pid;
    if (pid === undefined) {
      return Promise.resolve({
        manager: 'direct',
        state: 'absent',
        detail: 'no service manager owns the daemon on this host',
      });
    }
    return Promise.resolve(
      this.processes.alive(pid)
        ? { manager: 'direct', state: 'running', pid, detail: 'started directly by this command' }
        : { manager: 'direct', state: 'failed', pid, detail: 'the process this command started has exited' },
    );
  }
}
