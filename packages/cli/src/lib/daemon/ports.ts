import type { DaemonManagerKind } from './layout.ts';
/** What `GET /healthz` says about the serving daemon. `protocol` is any integer: process control never judges it. */
export interface LocalUpdateHealth {
  readonly protocol: number;
  readonly version: string;
  readonly pid: number;
}
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
  /**
   * Does process `pid` hold `path` open right now?
   *
   * `undefined` when this host offers no way to ask — never a guess in either direction, because the
   * one caller uses a `true` to decide that a pid is safe to signal.
   */
  holdsOpen(pid: number, path: string): Promise<boolean | undefined>;
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
  /**
   * Whether the home exists and carries the Ferretry marker; reads only, never claims. `empty` is a directory with
   * nothing in it, which the daemon's first start makes into a home.
   */
  inspect(home: string): Promise<'absent' | 'empty' | 'claimed' | 'unclaimed'>;
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
  /** The file's text, or `undefined` when there is none — only ever a definition this CLI wrote. */
  read(path: string): Promise<string | undefined>;
}

/**
 * Serializing this daemon's mutating lifecycle commands across separate invocations.
 *
 * Two `fy daemon` invocations are unrelated to each other, so an in-object queue orders nothing: one
 * could write the service definition between another's garbage-collection root update and its own
 * definition write, leaving a unit that names one executable while the root holds a different one's
 * closure. The daemon they contend for is identified by a path, so the claim lives at a path too.
 *
 * `acquire` throws when the claim cannot be taken; refusing a lifecycle command is safe, whereas
 * proceeding without exclusion is what produces the mismatch above.
 */
export interface IDaemonLifecycleLockPort {
  acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim>;
}

/** The mutating daemon-lifecycle commands, named in a claim so a refusal can say what is running. */
export type DaemonLifecycleVerb = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'reset';

/** What a lifecycle claim is asked for, so the wait bound stays the caller's policy rather than the adapter's. */
export interface DaemonLifecycleClaimRequest {
  readonly lockPath: string;
  readonly verb: DaemonLifecycleVerb;
  /** How long this caller is willing to wait for this individual claim; the adapter owns no budget policy. */
  readonly waitMs: number;
  /** Called once when a peer holds the claim, so a wait of that length is visible rather than a hang. */
  readonly waiting: (holder: string) => void;
  /**
   * Called when the claim on the name was left by a holder that has PROVABLY exited — killed, crashed
   * or out of memory — and was removed so this command could run. Said out loud because a claim that
   * vanished silently would read, to the next person debugging a lifecycle, as one that never existed.
   */
  readonly reclaimed: (holder: string) => void;
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

/** What the service manager believes about the daemon right now. */
export interface DaemonSupervisorReport {
  readonly manager: DaemonManagerKind;
  /** `absent`: no service definition. `stopped`: defined, not running. `failed`: it exited badly. */
  readonly state: 'absent' | 'stopped' | 'running' | 'failed';
  readonly pid?: number | undefined;
  /** Whatever the manager said, for a human reading a surprising verdict. */
  readonly detail?: string | undefined;
  /**
   * launchd only, and only when the plist is on disk: the `ProcessType` it declares, `null` when it
   * declares none. `null` is the throttled default — see `LAUNCHD_PROCESS_TYPE`.
   */
  readonly processType?: string | null | undefined;
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
  /** Install supervision and launch this exact absolute executable. */
  install(executable: string): Promise<void>;
  uninstall(): Promise<void>;
  /** Bring this exact absolute executable up; the controller guards healthy incumbents. */
  start(executable: string): Promise<DaemonStartHandle>;
  stop(request: StopRequest): Promise<void>;
  /** `handle` lets the direct supervisor watch the child it just started. */
  inspect(handle?: DaemonStartHandle): Promise<DaemonSupervisorReport>;
  /**
   * Throw unless what this supervisor would act on belongs to THIS layout's state home.
   *
   * `pidHint` is the pid an answering daemon reported for itself. The answer arrives over HTTP, so it
   * can be any process's number — a forwarded port, a container, a second installation — and a verb
   * that stops, restarts or resets must not act on a daemon it cannot tie to the state home it was
   * asked about.
   */
  assertServes(pidHint: number | undefined): Promise<void>;
}

/**
 * A supervisor backed by an on-disk service definition.
 *
 * Separating this from `IDaemonSupervisor` is what lets `install` name the file it wrote without a
 * `?? somewhere-else` fallback that no reachable input could ever take.
 */
export interface IServiceDefinitionSupervisor extends IDaemonSupervisor {
  readonly definitionPath: string;
  /**
   * Rewrite the definition for this exact executable and have the manager restart it in ONE command.
   *
   * Present only where the manager has such a command that also picks up a rewritten definition:
   * systemd's `restart` after a `daemon-reload` does, and stops, escalates and starts under its own
   * timeouts. launchd caches `ProgramArguments` at bootstrap, so it has no equivalent and leaves this
   * out; its restart stays stop, wait until down, reload.
   */
  readonly restartInPlace?: (executable: string) => Promise<void>;
}
export interface INixGcRootPort {
  /** Resolve symbolic links, so a profile or shim path is classified by what it actually points at. */
  realPath(path: string): Promise<string>;
  /**
   * Register an indirect GC root at `rootPath` for `storePath`.
   *
   * `undefined` on success; otherwise the reason it could not, for the caller to warn with.
   */
  pin(storePath: string, rootPath: string): Promise<string | undefined>;
  /** Drop a root. An absent root is success — releasing must retire the store path, not fail. */
  release(rootPath: string): Promise<void>;
}

export type { IClockPort } from '../update/machine.ts';

/**
 * Whether the daemon of this state home is answering, and which process it is.
 *
 * The pid is the daemon's own account of itself (`GET /healthz`) at the address its run record names. It is never
 * trusted alone: every signal sent to it first passes `assertServes`, which proves the pid holds this state home's
 * lifetime lock. `undefined` is "did not answer", a fact to report and not an error to raise.
 */
export interface IDaemonHealthPort {
  probe(): Promise<LocalUpdateHealth | undefined>;
}

/** Showing the daemon log: the one-shot read, or following it as it grows. */
export interface IDaemonLogPort {
  exists(logFile: string): Promise<boolean>;
  /** Streams the log to this terminal; the exit code of the reader. */
  show(logFile: string, follow: boolean): Promise<number>;
}

/** What one tree holds, measured or removed. */
export type ResetTreeMeasure =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'measured';
      readonly files: number;
      readonly bytes: number;
      /** `<path relative to the tree> -> <target>` for every link that points out of the tree. */
      readonly escapingLinks: readonly string[];
    };

/** The trees a reset destroys, measured and then removed. Every failure throws. */
export interface IResetTreePort {
  measure(root: string): Promise<ResetTreeMeasure>;
  remove(root: string): Promise<ResetTreeMeasure>;
}

/** What a reset destroys that nothing brings back, counted from the daemon that still holds it. */
export interface ResetCounts {
  readonly secrets: number;
  readonly devices: number;
  readonly ferrets: number;
}

export interface IResetInventoryPort {
  /** `undefined` when the daemon cannot be asked: a reset must never depend on the thing it recovers from. */
  count(): Promise<ResetCounts | undefined>;
}

export type SessionTerminalEnding =
  | { readonly kind: 'ended' }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly reason: string };

/** The private terminal server every ferret's agent runs under; it outlives a daemon stop. */
export interface ISessionTerminalServerPort {
  end(socket: string): Promise<SessionTerminalEnding>;
}

/** How many ferrets are mid-turn, for the line a restart says and for `--when-idle`. */
export interface IDaemonTurnsPort {
  midTurn(): Promise<number>;
}
