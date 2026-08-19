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
 * discovery returned rather than re-deriving it. Only the retired per-snapshot root directory an
 * earlier release wrote is still enumerated this way; the live root is one known path.
 */
export interface HeldGcRoot {
  /** Directory entry name, exactly as the root directory reported it. */
  readonly name: string;
  readonly path: string;
}

/**
 * Pinning a Nix store path so it cannot be garbage-collected.
 *
 * A daemon installed with `nix shell` has no garbage-collection root of its own: the store path is
 * live only while that shell is open, so a later `nix-collect-garbage` deletes the executable out
 * from under an installed service, which then breaks with no user action. That is why the root
 * survives the snapshot store: a person's own shell breaking afterwards is an accepted cost, but a
 * user service that cannot launch at the next login is a failure nobody is present to see, and the
 * absolute path a unit file must record is the exact path a collection can delete.
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
export type DaemonLifecycleVerb = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'reset';

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
 * definition write, leaving a unit that names one executable while the root holds a different one's
 * closure. The daemon they contend for is identified by a path, so the claim lives at a path too.
 *
 * `acquire` throws when the claim cannot be taken; refusing a lifecycle command is safe, whereas
 * proceeding without exclusion is what produces the mismatch above.
 */
export interface IDaemonLifecycleLockPort {
  acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim>;
}

/**
 * What removing one retired artifact tree did.
 *
 * Total on purpose, and `failed` is a VALUE rather than a rejection. Reclaiming disk an earlier
 * release left behind is tidying, and tidying may never fail a lifecycle verb — the daemon in front
 * of the operator is the thing that has to keep working. `absent` is the ordinary answer on every
 * host that never ran the release this cleans up after, and it says nothing to anybody.
 */
export type RetiredArtifactOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'removed'; readonly files: number; readonly bytes: number }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Removing a CLI-owned artifact tree an earlier release wrote and this one no longer keeps.
 *
 * Separate from `IServiceFilePort` because it makes a promise that port must never make: it forces
 * write permission back onto directories on the way down. The retired daemon snapshot store sealed
 * every snapshot directory read-only, so an ordinary recursive remove cannot unlink anything inside
 * one, and a store nobody can delete is the 100MB an operator is stuck with forever.
 */
export interface IRetiredArtifactPort {
  /** Remove `path` and everything under it; an absent path is `absent`, never a failure. */
  retire(path: string): Promise<RetiredArtifactOutcome>;
}

/**
 * What one tree holds, measured without removing anything.
 *
 * `escapingLinks` is the evidence for a promise this port makes and a person has no other way to
 * check: a symbolic link inside the tree that points OUT of it is unlinked and never followed, so a
 * link into somebody's real data costs them the link and nothing else. Naming them in the preflight is
 * how that stops being a claim.
 */
export type ResetTreeMeasure =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'measured';
      readonly files: number;
      readonly bytes: number;
      /** Rendered `<path inside the tree> -> <where it points>`, relative to the tree it was found in. */
      readonly escapingLinks: readonly string[];
    };

/**
 * Measuring and removing the trees a reset destroys.
 *
 * SEPARATE FROM `IRetiredArtifactPort`, and the difference is the failure contract rather than the
 * mechanics. Retiring an artifact an earlier release left behind is tidying, so it may never fail a
 * lifecycle verb and reports its problems as values. A reset that cannot remove what it just told
 * somebody it would remove has LIED to them, and half a reset is the state the whole verb exists to
 * stop people reaching by hand — so both methods here throw, and the verb fails with them.
 *
 * `measure` is a separate call rather than a return value of `remove` because the order is the point:
 * a person is shown the sizes and the counts, and only then asked. A measurement that arrived with the
 * removal would arrive too late to abort on.
 */
export interface IResetTreePort {
  measure(root: string): Promise<ResetTreeMeasure>;
  /**
   * Remove the tree and report what actually went; an absent tree is `absent`, not a failure. Never
   * follows a symbolic link out of the tree.
   *
   * It answers with its OWN measurement rather than nothing, because the preflight's numbers were
   * taken while the daemon was still running and writing. Reporting those as what was removed would be
   * a number nobody measured. The removal has to walk the tree anyway to unseal it, so counting on the
   * way down costs nothing and is the only count that is true.
   */
  remove(root: string): Promise<ResetTreeMeasure>;
}

/**
 * Counting what a reset destroys that nothing brings back, asked of the daemon that still owns it.
 *
 * The daemon is the authority on its own state and the CLI does not read it. `undefined` therefore
 * means "did not answer", which is information rather than a failure: a daemon that is already down
 * cannot be asked, and the preflight says so instead of guessing or counting files behind its back.
 */
export interface IResetInventoryPort {
  count(): Promise<{ readonly secrets: number; readonly devices: number } | undefined>;
}

/**
 * The typed confirmation a reset asks for, injected so no test blocks on a terminal.
 *
 * The same one-method shape `fy worktree rm` uses, for the same reason: this is the repository's
 * existing pattern for authorizing something irreversible, and a second pattern for one verb would
 * mean two rituals to learn for the same class of act.
 */
export interface IDaemonPrompt {
  ask(message: string): Promise<string>;
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
  /** Install supervision and launch this exact absolute executable. */
  install(executable: string): Promise<void>;
  uninstall(): Promise<void>;
  /** Bring this exact absolute executable up; the controller guards healthy incumbents. */
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
