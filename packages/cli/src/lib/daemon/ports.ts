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
 * Claiming the state home before this CLI creates anything inside it.
 *
 * The supervisor holds one because `<state home>/logs` is state INSIDE the daemon's home, and
 * creating state there without claiming the layout is what made a fresh install refuse to boot. The
 * port is the narrowest possible statement of that: "make this home ours, or refuse".
 */
export interface IStateHomeClaimPort {
  claim(home: string): Promise<unknown>;
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
 * One garbage-collection root that exists right now, reported with the path it was found at.
 *
 * The path travels back with the name so a caller that wants to drop a root passes back what
 * discovery returned. Re-deriving it would make this the second place a snapshot identity becomes a
 * root path, and `daemonSnapshotGcRoot` is deliberately the only one.
 */
export interface HeldGcRoot {
  /** Directory entry name, which for a root this CLI wrote is the snapshot id it protects. */
  readonly name: string;
  readonly path: string;
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
 * a daemon that refuses to start because a pin did not take, and a root directory that cannot be read
 * is answered as "nothing is held" so the caller pins rather than refuses.
 */
export interface INixGcRootPort {
  /** Resolve symbolic links, so a profile or shim path is classified by what it actually points at. */
  realPath(path: string): Promise<string>;
  /** Every root currently in `directory`; empty when it does not exist yet. */
  held(directory: string): Promise<readonly HeldGcRoot[]>;
  /**
   * Register an indirect GC root at `rootPath` for `storePath`.
   *
   * `undefined` on success; otherwise the reason it could not, for the caller to warn with.
   */
  pin(storePath: string, rootPath: string): Promise<string | undefined>;
  /** Drop a root. An absent root is success — releasing must retire the store path, not fail. */
  release(rootPath: string): Promise<void>;
}

/** The mutating daemon-lifecycle commands, named in a claim so a refusal can say what is running. */
export type DaemonLifecycleVerb =
  | 'install'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'snapshot build'
  | 'snapshot promote';

/** What a lifecycle claim is asked for, so the wait bound stays the caller's policy rather than the adapter's. */
export interface DaemonLifecycleClaimRequest {
  readonly lockPath: string;
  readonly verb: DaemonLifecycleVerb;
  /** How long this caller is willing to wait for this individual claim; the adapter owns no budget policy. */
  readonly waitMs: number;
  /** Called once when a peer holds the claim, so a wait of that length is visible rather than a hang. */
  readonly waiting: (holder: string) => void;
}

/** A held lifecycle claim. Released exactly once, by the holder that took it. */
export interface IDaemonLifecycleClaim {
  /**
   * Give the claim up.
   *
   * Never throws — it runs after the work it protected, and a tidy-up failure must not replace that
   * work's own outcome. Anything left behind travels back as the path a person has to look at.
   */
  release(): Promise<string | undefined>;
}

/**
 * Serializing this daemon's mutating lifecycle commands across separate invocations.
 *
 * Two `fy daemon` invocations are unrelated to each other, so an in-object queue orders nothing: one
 * could write the service definition between another's garbage-collection root update and its own
 * definition write, leaving a unit that names one snapshot while the roots protect a different one.
 * The daemon they contend for is identified by a path, so the claim lives at a path too.
 *
 * `acquire` throws when the claim cannot be taken; refusing a lifecycle command is safe, whereas
 * proceeding without exclusion is what produces the mismatch above.
 */
export interface IDaemonLifecycleLockPort {
  acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim>;
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
  /** The canonical immutable executable inside this snapshot, independent of ancestor aliases. */
  readonly binaryPath: string;
  readonly bytes: number;
  readonly createdAt: string;
}

/** Building an identical executable reuses its already-verified immutable snapshot. */
export interface DaemonSnapshotBuild extends DaemonSnapshot {
  readonly created: boolean;
}

/** One retained snapshot as garbage-collection reconciliation needs it: NAMED, never proven. */
export interface RetainedSnapshot {
  readonly id: string;
  /** The source recorded in its manifest, which is the closure a root has to hold. */
  readonly sourceBinary: string;
}

/** One retained-store entry that could not be trusted, as adapter facts rather than rendered prose. */
export interface RetainedSnapshotIssue {
  readonly path: string;
  readonly reason: string;
}

/**
 * What the store still retains, read cheaply and per entry.
 *
 * Two properties the verifying listing cannot have, and both are load-bearing:
 *
 * 1. **Per-entry tolerance.** An interrupted build leaves a directory that no later build repairs, by
 *    design. A listing that fails on the first such entry put one damaged sibling on the critical path
 *    of every mutating verb — `restart` stopped the daemon and then refused to start it again.
 * 2. **No proof.** Reconciliation needs an id and a source, never a verified executable. Digesting
 *    every retained binary made `start` cost more the longer a host had been building snapshots, and
 *    spent the lifecycle claim's budget on hashing.
 *
 * The discriminant is the whole point of the shape: it says whether these entries are the WHOLE
 * retained set. A caller may only ever ADD protection from an incomplete inventory, because an entry
 * that could not be read is a snapshot that still exists. The union makes two dangerous lies
 * unrepresentable: a complete inventory with skipped entries, and an incomplete one with no evidence
 * explaining why it cannot be trusted.
 */
export type RetainedSnapshotInventory =
  | {
      readonly snapshots: readonly RetainedSnapshot[];
      readonly complete: true;
      readonly unreadable: readonly [];
    }
  | {
      readonly snapshots: readonly RetainedSnapshot[];
      readonly complete: false;
      readonly unreadable: readonly [RetainedSnapshotIssue, ...RetainedSnapshotIssue[]];
    };

/**
 * Immutable daemon artifacts and their atomic promoted pointer.
 *
 * `undefined` from `current` means durable evidence says this store has never been promoted. A
 * missing or malformed pointer after promotion, manifest, marker or artifact throws: damaged durable
 * state must never be mistaken for an empty store and bootstrapped over.
 *
 * `list` is the OPERATOR REPORT and stays fully verified — a listing that says a snapshot is there is
 * saying it can be run. `retained` is the cheap inventory the lifecycle reconciles against, and the
 * two are kept apart because they answer different questions.
 */
export interface IDaemonSnapshotPort {
  build(): Promise<DaemonSnapshotBuild>;
  promote(id: string): Promise<DaemonSnapshot>;
  current(): Promise<DaemonSnapshot | undefined>;
  list(): Promise<readonly DaemonSnapshot[]>;
  /** Names every retained snapshot without proving any of them; never fails for one bad entry. */
  retained(): Promise<RetainedSnapshotInventory>;
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
  /** Install supervision and launch this exact verified immutable artifact. */
  install(executable: string): Promise<void>;
  uninstall(): Promise<void>;
  /** Bring this exact verified immutable artifact up; the controller guards healthy incumbents. */
  start(executable: string): Promise<DaemonStartHandle>;
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
}
