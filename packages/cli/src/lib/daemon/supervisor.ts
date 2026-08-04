import { dirname } from 'node:path';
import type { DaemonLayout } from './layout.ts';
import type {
  DaemonStartHandle,
  DaemonSupervisorReport,
  IDaemonProcessPort,
  IDaemonSupervisor,
  IServiceDefinitionSupervisor,
  IServiceFilePort,
  StopRequest,
} from './ports.ts';
import { parseLaunchdPrint, parseSystemdProperties, readLaunchdReport, readSystemdReport } from './probe.ts';
import { renderLaunchAgentPlist, renderSystemdUnit } from './unit-file.ts';

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

/** The description both service definitions carry. */
const description = (daemonName: string): string => `${daemonName} — per-host agent daemon`;

/** Drives a systemd user unit. */
export class SystemdSupervisor implements IServiceDefinitionSupervisor {
  readonly manager = 'systemd' as const;

  constructor(
    private readonly layout: DaemonLayout,
    private readonly processes: IDaemonProcessPort,
    private readonly files: IServiceFilePort,
  ) {}

  /** Where systemd reads this unit from, so an installer can name the file it wrote. */
  get definitionPath(): string {
    return this.layout.systemdUnitFile;
  }

  async installed(): Promise<boolean> {
    return await this.files.exists(this.definitionPath);
  }

  async install(): Promise<void> {
    await this.refresh();
    await this.#require(['enable', this.layout.systemdUnitName]);
    await this.#require(['restart', this.layout.systemdUnitName]);
  }

  async refresh(): Promise<void> {
    await this.files.ensureDirectory(dirname(this.layout.systemdUnitFile));
    await this.files.ensureDirectory(this.layout.logDirectory);
    await this.files.writePrivate(
      this.layout.systemdUnitFile,
      renderSystemdUnit({
        daemonBinary: this.layout.daemonBinary,
        stateHome: this.layout.stateHome,
        logFile: this.layout.logFile,
        searchPath: this.layout.searchPath,
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

  async start(): Promise<DaemonStartHandle> {
    await this.files.ensureDirectory(this.layout.logDirectory);
    await this.#require(['start', this.layout.systemdUnitName]);
    return {};
  }

  async stop(request: StopRequest): Promise<void> {
    await this.#require(
      request.escalate
        ? ['kill', '--signal=SIGKILL', this.layout.systemdUnitName]
        : ['stop', this.layout.systemdUnitName],
    );
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
  ) {}

  /** Where launchd reads this agent from, so an installer can name the file it wrote. */
  get definitionPath(): string {
    return this.layout.launchAgentFile;
  }

  async installed(): Promise<boolean> {
    return await this.files.exists(this.definitionPath);
  }

  async install(): Promise<void> {
    await this.refresh();
    // An unloaded job cannot be booted out, so this failure is expected and ignored.
    await this.processes.run(['launchctl', 'bootout', this.layout.launchdServiceTarget]);
    await this.#require(['bootstrap', this.layout.launchdDomain, this.layout.launchAgentFile]);
  }

  async refresh(): Promise<void> {
    await this.files.ensureDirectory(dirname(this.layout.launchAgentFile));
    await this.files.ensureDirectory(this.layout.logDirectory);
    await this.files.writePrivate(
      this.layout.launchAgentFile,
      renderLaunchAgentPlist({
        label: this.layout.launchdLabel,
        daemonBinary: this.layout.daemonBinary,
        stateHome: this.layout.stateHome,
        logFile: this.layout.logFile,
        searchPath: this.layout.searchPath,
        description: description(this.layout.daemonName),
      }),
    );
  }

  async uninstall(): Promise<void> {
    await this.processes.run(['launchctl', 'bootout', this.layout.launchdServiceTarget]);
    await this.files.remove(this.layout.launchAgentFile);
  }

  async start(): Promise<DaemonStartHandle> {
    await this.files.ensureDirectory(this.layout.logDirectory);
    const loaded = await this.processes.run(['launchctl', 'print', this.layout.launchdServiceTarget]);
    // `kickstart` without `-k` starts a stopped job and leaves a running one alone. kteam passed `-k`,
    // which means "kill the running instance first" — so its `start` restarted a perfectly healthy
    // daemon, dropping every in-flight request for no reason.
    await this.#require(
      loaded.code === 0
        ? ['kickstart', this.layout.launchdServiceTarget]
        : ['bootstrap', this.layout.launchdDomain, this.layout.launchAgentFile],
    );
    return {};
  }

  async stop(request: StopRequest): Promise<void> {
    await this.#require(
      request.escalate
        ? ['kill', 'SIGKILL', this.layout.launchdServiceTarget]
        : ['bootout', this.layout.launchdServiceTarget],
    );
  }

  async inspect(): Promise<DaemonSupervisorReport> {
    const present = await this.installed();
    const outcome = await this.processes.run(['launchctl', 'print', this.layout.launchdServiceTarget]);
    if (outcome.code !== 0) {
      return { manager: 'launchd', state: present ? 'stopped' : 'absent', detail: outcome.stderr.trim() };
    }
    return readLaunchdReport(parseLaunchdPrint(outcome.stdout), present);
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
  ) {}

  installed(): Promise<boolean> {
    return Promise.resolve(false);
  }

  install(): Promise<void> {
    return Promise.reject(new UnsupportedServiceManagerError());
  }

  uninstall(): Promise<void> {
    return Promise.reject(new UnsupportedServiceManagerError());
  }

  async start(): Promise<DaemonStartHandle> {
    await this.files.ensureDirectory(this.layout.logDirectory);
    return await this.processes.spawnDetached({
      argv: [this.layout.daemonBinary],
      environment: { FY_HOME: this.layout.stateHome, PATH: this.layout.searchPath },
      logFile: this.layout.logFile,
    });
  }

  stop(request: StopRequest): Promise<void> {
    if (request.pidHint !== undefined) {
      this.processes.signal(request.pidHint, request.escalate ? 'SIGKILL' : 'SIGTERM');
    }
    return Promise.resolve();
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
