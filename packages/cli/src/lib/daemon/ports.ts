import type { HealthView } from '@ferretry/protocol';
import type { DaemonManagerKind } from './layout.ts';

/** The result of one external command. */
export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How the daemon is launched when no service manager owns it. */
export interface DetachedLaunch {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Both streams are appended here, so a crash before the daemon opens its own log is still visible. */
  readonly logFile: string;
}

/** A process this CLI started, so a readiness wait can watch that exact child rather than a pid file. */
export interface DaemonStartHandle {
  readonly pid?: number | undefined;
}

/** Every process touch the daemon-control commands make, behind one interface. */
export interface IDaemonProcessPort {
  /** Run a service-manager command and capture it. */
  run(argv: readonly string[]): Promise<CommandOutcome>;
  /** Start the daemon detached from this CLI, surviving our exit. */
  spawnDetached(launch: DetachedLaunch): Promise<DaemonStartHandle>;
  /** Send a signal; `false` when the process was already gone. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  /** Does this pid still exist? */
  alive(pid: number): boolean;
}

/**
 * Reading the daemon log.
 *
 * kteam read the whole file into memory and wrote it out in one go, which is fine until the log is
 * hundreds of megabytes. Streaming it to the terminal is the adapter's job, so it stays a port.
 */
export interface IDaemonLogPort {
  exists(logFile: string): Promise<boolean>;
  /** Stream the log to this terminal and return the exit code of doing so. */
  show(logFile: string, follow: boolean): Promise<number>;
}

/**
 * Filesystem access, restricted to the artifacts this CLI itself creates: the service definition and
 * the log directory it points the service manager at. It never reads anything the daemon owns.
 */
export interface IServiceFilePort {
  exists(path: string): Promise<boolean>;
  /** Create the parent directory and write the file readable only by its owner. */
  writePrivate(path: string, contents: string): Promise<void>;
  /** Remove the file; absent is success. */
  remove(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}

/**
 * The daemon's own account of itself, over the protocol client.
 *
 * `undefined` means "did not answer" — the probe never throws, because every caller treats an
 * unreachable daemon as information rather than a failure.
 */
export interface IDaemonHealthPort {
  probe(): Promise<HealthView | undefined>;
}

/**
 * Pinning a Nix store path so it cannot be garbage-collected.
 *
 * A daemon installed with `nix shell` has no garbage-collection root of its own: the store path is
 * live only while that shell is open, so a later `nix-collect-garbage` deletes the executable out
 * from under an installed service, which then breaks with no user action. Running from an ephemeral
 * `nix shell` is a supported way to use this, so the fix is to hold the root ourselves rather than to
 * refuse the install.
 *
 * Every method reports rather than throws. A daemon that runs but is unpinned is strictly better than
 * a daemon that refuses to start because a pin did not take.
 */
export interface INixGcRootPort {
  /** Resolve symbolic links, so a profile or shim path is classified by what it actually points at. */
  realPath(path: string): Promise<string>;
  /**
   * Register an indirect GC root at `rootPath` for `storePath`.
   *
   * `undefined` on success; otherwise the reason it could not, for the caller to warn with.
   */
  pin(storePath: string, rootPath: string): Promise<string | undefined>;
  /** Drop a root. An absent root is success — an uninstall must release the store path, not fail. */
  release(rootPath: string): Promise<void>;
}

/** The daemon identity persisted in a snapshot, never inferred from its containing directory. */
export interface DaemonSnapshotIdentity {
  readonly product: string;
  readonly name: string;
}

/** One verified immutable daemon snapshot. */
export interface DaemonSnapshot {
  /** Content address: `sha256-` plus the executable's lowercase digest. */
  readonly id: string;
  readonly daemon: DaemonSnapshotIdentity;
  /** The resolved artifact that was complete and stable while this snapshot was built. */
  readonly sourceBinary: string;
  /** The immutable executable inside this snapshot. */
  readonly binaryPath: string;
  readonly bytes: number;
  readonly createdAt: string;
}

/** Building an identical executable reuses its already-verified immutable snapshot. */
export interface DaemonSnapshotBuild extends DaemonSnapshot {
  readonly created: boolean;
}

/**
 * Immutable daemon artifacts and their atomic promoted pointer.
 *
 * `undefined` from `current` means durable evidence says this store has never been promoted. A
 * missing or malformed pointer after promotion, manifest, marker or artifact throws: damaged durable
 * state must never be mistaken for an empty store and bootstrapped over.
 */
export interface IDaemonSnapshotPort {
  build(): Promise<DaemonSnapshotBuild>;
  promote(id: string): Promise<DaemonSnapshot>;
  current(): Promise<DaemonSnapshot | undefined>;
  list(): Promise<readonly DaemonSnapshot[]>;
}

/** Time, injected so the readiness and shutdown waits are testable without real delay. */
export interface IClockPort {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

/**
 * Presentation port. Deliberately the narrowest slice of the shipped `ConsoleIo` adapter these
 * commands use, so the production adapter satisfies it structurally and no second terminal adapter
 * has to exist.
 */
export interface IDaemonOutput {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** What the service manager believes about the daemon right now. */
export interface DaemonSupervisorReport {
  readonly manager: DaemonManagerKind;
  /** `absent`: no service definition. `stopped`: defined, not running. `failed`: it exited badly. */
  readonly state: 'absent' | 'stopped' | 'running' | 'failed';
  readonly pid?: number | undefined;
  /** Whatever the manager said, for a human reading a surprising verdict. */
  readonly detail?: string | undefined;
}

/** How a stop is pressed: politely first, then harder. */
export interface StopRequest {
  /** The pid the daemon reported for itself, when it was still answering. */
  readonly pidHint?: number | undefined;
  /** Escalate to an unconditional kill — only after a polite stop was given time to work. */
  readonly escalate: boolean;
}

/** One way of owning the daemon process: a service manager, or a plain detached child. */
export interface IDaemonSupervisor {
  readonly manager: DaemonManagerKind;
  /** Is a service definition installed for this host? */
  installed(): Promise<boolean>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  /** Bring the daemon up. Idempotent: never disturbs a healthy incumbent. */
  start(): Promise<DaemonStartHandle>;
  stop(request: StopRequest): Promise<void>;
  /** `handle` lets the direct supervisor watch the child it just started. */
  inspect(handle?: DaemonStartHandle): Promise<DaemonSupervisorReport>;
}

/**
 * A supervisor backed by an on-disk service definition.
 *
 * Separating this from `IDaemonSupervisor` is what lets `install` name the file it wrote without a
 * `?? somewhere-else` fallback that no reachable input could ever take.
 */
export interface IServiceDefinitionSupervisor extends IDaemonSupervisor {
  readonly definitionPath: string;
  /** Rewrite the definition to the current promoted snapshot without disturbing a running daemon. */
  refresh(): Promise<void>;
}
