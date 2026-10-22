import type { DaemonUpdateView, HealthView, InstallFacts } from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../../../src/lib/daemon/binary';
import type { CommandOutcome } from '../../../src/lib/daemon/ports';
import type { UpdateActivity, UpdateObserver } from '../../../src/lib/update/activity';
import type {
  IDaemonUpdateViewPort,
  IInstallFactsPort,
  ILatestReleasePort,
  IPackageManagerPort,
  IStandaloneReleasePort,
  IUpdateLifecyclePort,
  LatestReleaseAnswer,
  StagedRelease,
  StandaloneRefusal,
} from '../../../src/lib/update/ports';
import { health } from '../daemon/fixtures';

export const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-1.2.3';
export const USER_HOME = '/tmp/fy-home';
export const PROFILE_DAEMON = `${USER_HOME}/.nix-profile/bin/fyd`;

/** The facts for each install method a suite stages, by the path the daemon was found at. */
function factsFor(kind: string, daemonPath: string): InstallFacts {
  const base = {
    product: 'ferretry',
    compiled: true,
    launchedPath: daemonPath,
    resolvedPath: daemonPath,
    homeDirectory: USER_HOME,
    platform: 'linux',
  };
  switch (kind) {
    case 'homebrew':
      return { ...base, platform: 'darwin', resolvedPath: '/opt/homebrew/Caskroom/ferretry/1.2.3/fyd' };
    case 'nix-profile':
      return { ...base, resolvedPath: `${STORE}/bin/fyd`, nixProfileElement: 'ferretry' };
    case 'nix-shell':
      return { ...base, launchedPath: `${STORE}/bin/fyd`, resolvedPath: `${STORE}/bin/fyd` };
    case 'nix-module':
      return { ...base, launchedPath: '/run/current-system/sw/bin/fyd', resolvedPath: `${STORE}/bin/fyd` };
    case 'system-package':
      return { ...base, systemPackage: 'apt' };
    case 'unknown':
      return { ...base, compiled: false };
    default:
      return base;
  }
}

export class FakeFacts implements IInstallFactsPort {
  readonly asked: string[] = [];

  constructor(private readonly kind: string) {}

  facts(daemon: InstalledDaemonBinary): Promise<InstallFacts> {
    this.asked.push(daemon.path);
    return Promise.resolve(factsFor(this.kind, daemon.path));
  }
}

const release130: LatestReleaseAnswer = {
  kind: 'found',
  release: { version: '1.3.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.0' },
};

export class FakeLatest implements ILatestReleasePort {
  calls = 0;
  tagCalls = 0;

  constructor(
    private readonly answer: LatestReleaseAnswer = release130,
    private readonly tag: LatestReleaseAnswer = release130,
  ) {}

  newestTag(): Promise<LatestReleaseAnswer> {
    this.tagCalls += 1;
    return Promise.resolve(this.tag);
  }

  latest(): Promise<LatestReleaseAnswer> {
    this.calls += 1;
    return Promise.resolve(this.answer);
  }
}

/**
 * The host an update acts on: which version each executable path reports, and which version serves.
 * Package managers and the lifecycle below both move it, so a suite can stage any history.
 */
export class FakeHost {
  readonly versions = new Map<string, string | undefined>();
  /** The version serving right now; `undefined` when nothing serves. */
  running: string | undefined;
  /** The path the service definition names. */
  definition: string;
  /** What the next restart serves instead of the installed version, once. */
  serveOnce: Array<string | undefined> = [];
  restartFailures = 0;
  readonly trail: string[] = [];

  constructor(daemonPath: string, version: string, running: boolean) {
    this.definition = daemonPath;
    this.versions.set(daemonPath, version);
    this.running = running ? version : undefined;
  }

  bringUp(): void {
    if (this.restartFailures > 0) {
      this.restartFailures -= 1;
      this.running = undefined;
      throw new Error('fyd started but its process exited during startup');
    }
    this.running = this.serveOnce.length > 0 ? this.serveOnce.shift() : this.versions.get(this.definition);
  }
}

export class FakePackages implements IPackageManagerPort {
  /** What each upgrade sets the daemon path to; `undefined` leaves it alone. */
  upgradeTo: string | undefined = '1.3.0';
  failures = new Set<string>();
  /** What each command tells an observer, in order, before it finishes. */
  activities: UpdateActivity[] = [];

  constructor(
    private readonly host: FakeHost,
    private readonly daemonPath: string,
  ) {}

  #ran(name: string, apply: () => void): Promise<CommandOutcome> {
    this.host.trail.push(name);
    if (this.failures.has(name)) return Promise.resolve({ code: 1, stdout: '', stderr: `error: ${name} broke\n` });
    apply();
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  #previous: string | undefined;

  #tell(observer: UpdateObserver | undefined): void {
    for (const activity of this.activities) observer?.(activity);
  }

  #upgrade(): void {
    this.#previous = this.host.versions.get(this.daemonPath);
    if (this.upgradeTo !== undefined) this.host.versions.set(this.daemonPath, this.upgradeTo);
  }

  brewRefresh(tap: string, url: string): Promise<CommandOutcome> {
    return this.#ran(`brew-refresh:${tap}:${url}`, () => undefined);
  }

  brewUpgrade(cask: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    this.#tell(observer);
    return this.#ran(`brew:${cask}`, () => this.#upgrade());
  }

  nixProfileUpgrade(element: string, observer?: UpdateObserver): Promise<CommandOutcome> {
    this.#tell(observer);
    return this.#ran(`nix-upgrade:${element}`, () => this.#upgrade());
  }

  nixProfileRollback(): Promise<CommandOutcome> {
    return this.#ran('nix-rollback', () => this.host.versions.set(this.daemonPath, this.#previous));
  }

  nixProfileInstall(flake: string): Promise<CommandOutcome> {
    return this.#ran(`nix-install:${flake}`, () => this.host.versions.set(PROFILE_DAEMON, this.upgradeTo));
  }
}

export class FakeStandalone implements IStandaloneReleasePort {
  refusal: string | undefined;
  #previous: string | undefined;

  constructor(
    private readonly host: FakeHost,
    private readonly daemonPath: string,
  ) {}

  /** The version a swap leaves installed. */
  delivers = '1.3.0';

  /** What staging tells an observer, in order. */
  activities: UpdateActivity[] = [];

  stage(version: string, directory: string, observer?: UpdateObserver): Promise<StagedRelease | StandaloneRefusal> {
    for (const activity of this.activities) observer?.(activity);
    this.host.trail.push(`stage:${version}:${directory}`);
    if (this.refusal !== undefined) return Promise.resolve({ refused: this.refusal });
    return Promise.resolve({ directory, names: ['fy', 'fyd'] });
  }

  swap(staged: StagedRelease): Promise<void> {
    this.host.trail.push(`swap:${staged.names.join(',')}`);
    this.#previous = this.host.versions.get(this.daemonPath);
    this.host.versions.set(this.daemonPath, this.delivers);
    return Promise.resolve();
  }

  rollback(directory: string): Promise<void> {
    this.host.trail.push(`rollback:${directory}`);
    this.host.versions.set(this.daemonPath, this.#previous);
    return Promise.resolve();
  }
}

/** A service manager over `FakeHost`: restart serves whatever the definition's path now reports. */
export class FakeLifecycle implements IUpdateLifecyclePort {
  missing: string | undefined;
  /** Why the installed definition is stale; `undefined` for one that is current. */
  stale: string | undefined;
  readonly executables = new Set<string>();

  constructor(
    private readonly host: FakeHost,
    private readonly daemonPath: string,
  ) {}

  installed(): InstalledDaemonBinary {
    if (this.missing !== undefined) throw new Error(this.missing);
    return { path: this.daemonPath, source: 'PATH', version: this.host.versions.get(this.daemonPath) };
  }

  versionOf(path: string): string | undefined {
    return this.host.versions.get(path);
  }

  executable(path: string): boolean {
    return this.executables.has(path);
  }

  readonly restarts: (number | undefined)[] = [];

  restart(options?: { readonly ferretsKeepRunning?: number }): Promise<void> {
    this.restarts.push(options?.ferretsKeepRunning);
    this.host.trail.push('restart');
    this.host.bringUp();
    return Promise.resolve();
  }

  installAt(path: string): Promise<void> {
    this.host.trail.push(`install:${path}`);
    this.host.definition = path;
    this.host.bringUp();
    return Promise.resolve();
  }

  staleDefinition(): Promise<string | undefined> {
    return Promise.resolve(this.stale);
  }

  probe(): Promise<HealthView | undefined> {
    return Promise.resolve(this.host.running === undefined ? undefined : health({ version: this.host.running }));
  }
}

/** The daemon's update view, answering a scripted mid-turn count per look, then the last forever. */
export class FakeUpdateView implements IDaemonUpdateViewPort {
  looks = 0;

  constructor(private readonly midTurn: readonly (number | undefined)[] = [0]) {}

  view(): Promise<DaemonUpdateView | undefined> {
    const midTurn = this.midTurn[Math.min(this.looks, this.midTurn.length - 1)];
    this.looks += 1;
    if (midTurn === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      current: '1.2.3',
      method: { kind: 'homebrew', cask: 'ferretry' },
      plan: {
        kind: 'self',
        steps: [{ command: 'brew upgrade --cask ferretry' }, { command: 'fy daemon restart' }],
        rollback: 'none',
      },
      check: {
        state: 'ok',
        checkedAt: '2026-10-18T09:00:00.000Z',
        latest: { version: '1.3.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.0' },
      },
      available: true,
      midTurn,
      autoInstall: false,
      job: null,
    });
  }
}

export class FakeReports {
  readonly written = new Map<string, string>();
  fails = false;

  writePrivate(path: string, contents: string): Promise<void> {
    if (this.fails) return Promise.reject(new Error('read-only file system'));
    this.written.set(path, contents);
    return Promise.resolve();
  }
}
