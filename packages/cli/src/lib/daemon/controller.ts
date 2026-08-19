import type { HealthView } from '@ferretry/protocol';
import type { InstalledDaemonBinary } from './binary.ts';
import type { DaemonLayout } from './layout.ts';
import { nixStorePathOf } from './nix-store.ts';
import type {
  DaemonLifecycleVerb,
  DaemonStartHandle,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonSupervisor,
  INixGcRootPort,
  IRetiredArtifactPort,
  IServiceDefinitionSupervisor,
  RetiredArtifactOutcome,
} from './ports.ts';
import { livenessOf } from './probe.ts';
import {
  beginReadinessWait,
  decideReadiness,
  decideShutdown,
  defaultReadinessPolicy,
  defaultShutdownPolicy,
  type ReadinessPolicy,
  type ShutdownPolicy,
} from './readiness.ts';
import {
  decideDaemonStatus,
  renderDaemonStatus,
  renderDaemonStatusJson,
  renderInstalled,
  statusExitCode,
} from './render.ts';
import { UnsupportedServiceManagerError } from './supervisor.ts';

/** Options the daemon commands accept. */
export interface DaemonCommandOptions {
  /** Emit the machine shape instead of the human summary. */
  readonly json?: boolean;
  /** Keep streaming the log as it grows. */
  readonly follow?: boolean;
}

export class DaemonStartupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartupFailedError';
  }
}

/**
 * What a holder may spend outside its readiness and shutdown waits: locating the installed daemon,
 * holding its closure, and retiring what an earlier release left behind. A peer waits this much
 * longer before refusing.
 */
const LIFECYCLE_RECONCILIATION_ALLOWANCE_MS = 30_000;

export class DaemonShutdownFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonShutdownFailedError';
  }
}

/** Reclaimed disk, in the unit a person recognises. One decimal is as much precision as this means. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

/** What the controller needs; a struct so the composition root reads as a wiring list. */
export interface DaemonControllerDeps {
  readonly layout: DaemonLayout;
  /** The service manager for this platform, or `undefined` where there is none. */
  readonly service: IServiceDefinitionSupervisor | undefined;
  /** The always-available fallback: the daemon as a detached child. */
  readonly direct: IDaemonSupervisor;
  readonly health: IDaemonHealthPort;
  readonly logs: IDaemonLogPort;
  /** Holds a Nix-store daemon against garbage collection; a no-op for any other installation. */
  readonly nix: INixGcRootPort;
  /** Serializes every mutating verb below against the same verbs in other invocations. */
  readonly lifecycle: IDaemonLifecycleLockPort;
  /**
   * The daemon executable this host runs, or a THROW naming the remedy when there is none.
   *
   * Required, and required to be total in the sense that it either answers or explains. There is no
   * second candidate to fall back to now that no copy of the executable is kept: an invocation that
   * cannot say which file to launch cannot launch anything, and saying so is strictly better than a
   * unit file naming a path chosen by default.
   */
  readonly installedDaemon: () => InstalledDaemonBinary;
  /** Removes CLI-owned artifact trees an earlier release wrote and this one no longer keeps. */
  readonly retired: IRetiredArtifactPort;
  readonly clock: IClockPort;
  readonly out: IDaemonOutput;
  /**
   * The first-operator-password offer, made after a start that a PERSON asked for.
   *
   * REQUIRED rather than optional, because an absent one is indistinguishable from a controller that
   * silently never asks — and "the machine quietly stopped offering" is the failure mode this whole
   * requirement exists to remove. It decides for itself whether anybody is there to answer; see
   * `FirstPasswordOffer` for why it can never block a start.
   */
  readonly firstPassword: IFirstPasswordOffer;
  readonly readiness?: ReadinessPolicy;
  readonly shutdown?: ShutdownPolicy;
}

/** Offering to set this machine's first operator password. Satisfied by `FirstPasswordOffer`. */
interface IFirstPasswordOffer {
  offer(): Promise<void>;
}

/**
 * Drives `fy daemon …`: installs and removes the service definition, brings the daemon up and down,
 * reports on it and streams its log.
 *
 * The daemon's own HTTP API is the authority on whether it is up, and the service manager is the
 * authority on whether it is supervised. Neither answer comes from a file under the state home — the
 * CLI does not read the daemon's state, which is the seam the whole package split exists to enforce.
 *
 * THE DAEMON THAT RUNS IS THE DAEMON THIS HOST HAS INSTALLED. There is no copy, no promotion and no
 * pointer of our own: `install`, `start` and `restart` resolve the installed executable and record or
 * launch that absolute path. An upgrade is therefore whatever the package manager already did plus a
 * `restart`, and a rollback is the same — this CLI never became a second, worse package manager for
 * one file.
 *
 * EVERY MUTATING VERB IS ONE SERIALIZED TRANSACTION, and the ones that only report are not. Each
 * mutating verb holds the executable's garbage-collection root and then writes a service definition
 * or launches that executable, and those two halves have to agree about which file is in play: two
 * invocations that interleave them leave a unit file naming one executable while the root holds
 * another's closure. Claims keyed on every ownership target are what make the pair atomic against a
 * peer invocation, and they are taken in the public verb rather than deeper down so no verb can ever
 * nest inside another.
 */
export class DaemonController {
  private readonly readiness: ReadinessPolicy;
  private readonly shutdown: ShutdownPolicy;

  constructor(private readonly deps: DaemonControllerDeps) {
    this.readiness = deps.readiness ?? defaultReadinessPolicy();
    this.shutdown = deps.shutdown ?? defaultShutdownPolicy();
  }

  async install(): Promise<void> {
    await this.#serialized('install', () => this.#install());
  }

  async uninstall(): Promise<void> {
    await this.#serialized('uninstall', () => this.#uninstall());
  }

  /**
   * Brings the daemon up, then — if a person is there — offers to set the machine's first password.
   *
   * THE OFFER IS OUTSIDE THE LIFECYCLE CLAIM, and that placement is the point rather than tidiness. A
   * prompt inside the claim would hold every other `fy daemon …` invocation on this host for as long
   * as somebody stared at the question: `stop` would appear to hang, and the operator's remedy would
   * be to kill the terminal that was asking them something. Nothing in the offer touches the state
   * this verb serialises — it speaks to the daemon that is now serving.
   *
   * A FAILED START ASKS NOTHING, because `#serialized` throws before this line.
   */
  async start(): Promise<void> {
    await this.#serialized('start', () => this.#start());
    await this.deps.firstPassword.offer();
  }

  async stop(): Promise<void> {
    await this.#serialized('stop', () => this.#stop());
  }

  async restart(): Promise<void> {
    await this.#serialized('restart', () => this.#restart());
  }

  async #install(): Promise<void> {
    const daemon = this.deps.installedDaemon();
    const service = this.#service();
    // Before the definition is written, so a unit file never names a store path nothing is holding.
    await this.#holdDaemonClosure(daemon.path);
    await service.install(daemon.path);
    const health = await this.#awaitReady(service, {});
    await this.#retireLegacyArtifacts();
    this.deps.out.success(renderInstalled(this.#name, service.definitionPath, health.pid));
  }

  async #uninstall(): Promise<void> {
    const service = this.#service();
    await service.uninstall();
    // REMOVING SUPERVISION DOES NOT UNINSTALL THE DAEMON, so it does not release the daemon's root.
    //
    // The asymmetry with `stop` was always the point: in a `nix shell`, releasing the root when the
    // daemon goes down means a garbage collection can leave the next `start` with no executable at
    // all — and `fy daemon start` still runs the daemon as a direct child on a host with no service
    // definition. The root belongs to the executable on this host's PATH, and that executable is
    // exactly as installed after this verb as it was before it. It is released when the installed
    // daemon stops being a store path, and named here because a held store path an operator cannot
    // account for is its own kind of surprise.
    await this.#retireLegacyArtifacts();
    this.deps.out.success(
      `${this.#name} user service removed; the installed daemon's Nix closure stays held by ${this.deps.layout.nixGcRoot} so a later fy daemon start still works`,
    );
  }

  async #start(): Promise<void> {
    const serving = await this.deps.health.probe();
    if (serving !== undefined) {
      this.#warnIfRunningIsStale(serving);
      this.deps.out.success(`${this.#name} is already serving (pid ${String(serving.pid)})`);
      return;
    }
    const owner = await this.#owner();
    const incumbent = await owner.inspect();
    if (incumbent.state === 'running') {
      // A service manager reports `activating` as running. Leave that incumbent's executable and its
      // root untouched, but still honor `start`'s contract to wait until its API serves.
      const ready = await this.#awaitReady(owner, {}, true);
      this.#warnIfRunningIsStale(ready);
      this.deps.out.success(`${this.#name} ready (pid ${String(ready.pid)})`);
      return;
    }
    const daemon = this.deps.installedDaemon();
    await this.#holdDaemonClosure(daemon.path);
    const handle = await owner.start(daemon.path);
    const health = await this.#awaitReady(owner, handle);
    await this.#retireLegacyArtifacts();
    this.deps.out.success(`${this.#name} ready (pid ${String(health.pid)})`);
  }

  async #stop(): Promise<void> {
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    if (!(await this.#running(owner, health))) {
      this.deps.out.warn(`${this.#name} is not running`);
      return;
    }
    await this.#pressStop(owner, health?.pid);
    this.deps.out.success(`${this.#name} stopped`);
  }

  async #restart(): Promise<void> {
    // Locate the executable BEFORE stopping the incumbent. A host with no daemon on its PATH cannot
    // start one, and an operator must learn that while the healthy daemon is still serving — never
    // only after restart has already created downtime it cannot undo.
    const daemon = this.deps.installedDaemon();
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    if (await this.#running(owner, health)) await this.#pressStop(owner, health?.pid);
    else this.deps.out.warn(`${this.#name} was not running; starting it`);
    // Restart is when an upgraded executable is picked up, so the root is reconciled here too.
    await this.#holdDaemonClosure(daemon.path);
    const handle = await owner.start(daemon.path);
    const ready = await this.#awaitReady(owner, handle);
    await this.#retireLegacyArtifacts();
    this.deps.out.success(`${this.#name} restarted (pid ${String(ready.pid)})`);
  }

  async status(options: DaemonCommandOptions): Promise<void> {
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    const supervisor = await owner.inspect(this.#handleFor(health));
    const view = decideDaemonStatus(this.#name, supervisor, health);
    const code = statusExitCode(view);
    if (options.json === true) this.deps.out.success(renderDaemonStatusJson(view));
    else if (code === 0) this.deps.out.success(renderDaemonStatus(view));
    else this.deps.out.warn(renderDaemonStatus(view));
    if (options.json !== true && health !== undefined) this.#warnIfRunningIsStale(health);
    if (code !== 0) this.deps.out.setExitCode(code);
  }

  /**
   * The two daemon identities that still exist, and whether they agree.
   *
   * It used to report three — installed, promoted, running — and the middle one is what this command
   * was mostly for: an operator who had upgraded the executable and was still being served by a
   * snapshot promoted weeks earlier had no other way to see it. There is no third identity now.
   * `install`, `start` and `restart` record and launch the installed executable, so the only question
   * left is whether the daemon serving right now predates the executable on this host's PATH, which is
   * answered by comparing the two versions and naming the one command that closes the gap.
   *
   * A daemon that cannot be located is REPORTED WITH ITS REASON rather than as a bare absence, because
   * the two causes need different remedies: not installed at all, and installed at a path a service
   * manager could never launch.
   */
  async which(options: DaemonCommandOptions): Promise<void> {
    const located = this.#locateDaemon();
    const running = await this.deps.health.probe();
    const payload = {
      installed:
        'reason' in located
          ? { state: 'not-found' as const, reason: located.reason }
          : { state: 'found' as const, path: located.path, source: located.source, version: located.version ?? null },
      running:
        running === undefined
          ? { state: 'not-running' as const }
          : { state: 'running' as const, pid: running.pid, version: running.version },
    };
    if (options.json === true) {
      this.deps.out.success(JSON.stringify(payload, null, 2));
      return;
    }
    const lines = [
      payload.installed.state === 'found'
        ? `installed: ${payload.installed.path} (${payload.installed.source}, version ${payload.installed.version ?? 'unknown'})`
        : `installed: ${payload.installed.reason}`,
      payload.running.state === 'running'
        ? `running: pid ${String(payload.running.pid)} version ${payload.running.version}`
        : 'running: daemon is not running',
    ];
    if (running !== undefined && !('reason' in located) && located.version !== undefined) {
      lines.push(
        running.version === located.version
          ? 'the running daemon is the installed one'
          : 'running and installed differ; run fy daemon restart to use the installed daemon',
      );
    }
    this.deps.out.success(lines.join('\n'));
  }

  async logs(options: DaemonCommandOptions): Promise<void> {
    const file = this.deps.layout.logFile;
    const follow = options.follow === true;
    // A missing log is reported, not silently rendered as an empty one — kteam swallowed the error and
    // printed nothing, which reads identically to a daemon that ran and logged nothing.
    if (!follow && !(await this.deps.logs.exists(file))) {
      this.deps.out.warn(`no ${this.#name} log at ${file} yet`);
      return;
    }
    const code = await this.deps.logs.show(file, follow);
    if (code !== 0) this.deps.out.setExitCode(code);
  }

  get #name(): string {
    return this.deps.layout.daemonName;
  }

  /**
   * Run one mutating verb as an exclusive daemon-keyed transaction.
   *
   * The wait bound is this controller's own policy rather than the adapter's guess: a peer inside a
   * `restart` may legitimately hold the claim for a whole shutdown followed by a whole startup, and a
   * bound shorter than that would refuse commands that were only ever queued behind a healthy one.
   * The allowance on top is the work those two policies do not describe — holding the root and
   * retiring what an earlier release left behind — because a bound equal to the holder's best case
   * refuses a peer for no reason but the holder having been thorough.
   */
  async #serialized<T>(verb: DaemonLifecycleVerb, work: () => Promise<T>): Promise<T> {
    const waitMs = this.shutdown.deadlineMs + this.readiness.deadlineMs + LIFECYCLE_RECONCILIATION_ALLOWANCE_MS;
    const claims: IDaemonLifecycleClaim[] = [];
    try {
      // The layout supplies one semantic order, independent of unresolved path spelling. Holding an
      // earlier claim while waiting for a later one is therefore deadlock-free even when two
      // invocations overlap on only one target or reach it through different aliases.
      for (const lockPath of this.deps.layout.lifecycleLocks) {
        claims.push(
          await this.deps.lifecycle.acquire({
            lockPath,
            verb,
            waitMs,
            waiting: holder =>
              this.deps.out.warn(
                `${this.#name} ${verb} is waiting up to ${String(Math.round(waitMs / 1_000))}s for another lifecycle command to finish (${holder})`,
              ),
          }),
        );
      }
      return await work();
    } finally {
      // Release in the reverse acquisition order. This also gives back a partial set when a later
      // acquisition is refused, before any lifecycle work has run.
      for (let index = claims.length - 1; index >= 0; index -= 1) {
        const residue = await claims[index]?.release();
        if (residue !== undefined) {
          this.deps.out.warn(
            `${this.#name} lifecycle claim ${residue} could not be released; remove it once no ${this.#name} lifecycle command is running`,
          );
        }
      }
    }
  }

  /**
   * Hold the Nix closure of the executable this verb is about to record or launch.
   *
   * `nix shell github:…` is a supported way to run this, and a store path is a root only while that
   * shell is open. The absolute path a unit file has to name is therefore a path a later
   * `nix-collect-garbage` can delete, and an installed user service that names a collected path does
   * not start at the next login. THAT is the failure this holds against — not a person's own shell
   * going stale afterwards, which is an accepted cost.
   *
   * One root, because there is one executable. An installation outside the store cannot be collected
   * and asks for nothing, and any root left over from an earlier Nix installation is RELEASED there:
   * it would otherwise hold a closure of something this host no longer runs, forever.
   *
   * NOTHING HERE MAY FAIL A VERB. A pin is protection against a collection that may never happen; the
   * daemon in front of the operator is the thing that has to keep working, so a refusal is a warning
   * naming the sturdier installation method and the verb carries on.
   */
  async #holdDaemonClosure(binaryPath: string): Promise<void> {
    const root = this.deps.layout.nixGcRoot;
    const storePath = nixStorePathOf(await this.deps.nix.realPath(binaryPath));
    if (storePath === undefined) {
      await this.deps.nix.release(root);
      return;
    }
    const failure = await this.deps.nix.pin(storePath, root);
    if (failure === undefined) return;
    this.deps.out.warn(
      `${this.#name} runs from the Nix store but its runtime closure could not be pinned against ` +
        `garbage collection (${failure}); a later nix-collect-garbage may remove ${storePath} and the ` +
        `service will not start — install with \`nix profile install\` to have Nix hold it instead`,
    );
  }

  /**
   * Remove the daemon snapshot store, and its roots, that an earlier release left on this host.
   *
   * **Only ever called after a verb has actually recorded or removed a service definition**, and that
   * ordering is the whole safety argument. An upgraded host's unit file still names an artifact inside
   * the store, so deleting the store first would leave a service that cannot launch. `install`,
   * `start` and `restart` rewrite the definition with the installed executable's absolute path before
   * they reach this, and `uninstall` has removed it; only then is nothing pointing at the store.
   *
   * It runs rather than telling somebody to run it because the store is roughly 100MB of copies of an
   * executable that is already installed, it is ours, and an instruction in release notes is an
   * instruction almost nobody follows. What it removed is said OUT LOUD, once, on the one invocation
   * that does it — a machine quietly deleting 100MB and mentioning nothing is worse than the disk.
   *
   * NOTHING HERE MAY FAIL A VERB either. Reclaiming disk is tidying; the daemon is the work.
   */
  async #retireLegacyArtifacts(): Promise<void> {
    const layout = this.deps.layout;
    for (const root of await this.deps.nix.held(layout.legacySnapshotGcRootDirectory)) {
      await this.deps.nix.release(root.path);
    }
    const attempts: ReadonlyArray<readonly [string, RetiredArtifactOutcome]> = [
      [layout.legacySnapshotGcRootDirectory, await this.deps.retired.retire(layout.legacySnapshotGcRootDirectory)],
      [layout.legacySnapshotRoot, await this.deps.retired.retire(layout.legacySnapshotRoot)],
    ];
    let files = 0;
    let bytes = 0;
    for (const [path, outcome] of attempts) {
      if (outcome.kind === 'removed') {
        files += outcome.files;
        bytes += outcome.bytes;
      }
      if (outcome.kind === 'failed') {
        this.deps.out.warn(
          `${this.#name} could not remove its retired snapshot store at ${path} (${outcome.reason}); ` +
            `nothing reads it any more, so it is safe to delete by hand`,
        );
      }
    }
    if (files === 0) return;
    this.deps.out.warn(
      `removed the retired ${this.#name} snapshot store (${String(files)} files, ${megabytes(bytes)}); ` +
        `${this.#name} now runs the daemon installed on this host instead of a copy of it`,
    );
  }

  /** The supervisor that currently owns the daemon: the service manager when one is installed. */
  async #owner(): Promise<IDaemonSupervisor> {
    const service = this.deps.service;
    if (service !== undefined && (await service.installed())) return service;
    return this.deps.direct;
  }

  #service(): IServiceDefinitionSupervisor {
    const service = this.deps.service;
    if (service === undefined) throw new UnsupportedServiceManagerError();
    return service;
  }

  /** The installed daemon, or why this host has none — for the verbs that only REPORT. */
  #locateDaemon(): InstalledDaemonBinary | { readonly reason: string } {
    try {
      return this.deps.installedDaemon();
    } catch (error: unknown) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Say so when the daemon already serving is older than the one installed here.
   *
   * The version is the only honest comparison left. Comparing PATHS would report a difference every
   * time a package manager moved its own files around, and it cannot see the case that matters — an
   * upgrade in place, where the path is identical and the code is not. A daemon whose version cannot
   * be read says nothing rather than guessing, because a wrong "restart me" is worse than silence.
   */
  #warnIfRunningIsStale(running: HealthView): void {
    const located = this.#locateDaemon();
    if ('reason' in located || located.version === undefined || located.version === running.version) return;
    this.deps.out.warn(
      `the running ${this.#name} is version ${running.version} but ${located.path} is ${located.version}; ` +
        `run fy daemon restart to use the installed daemon`,
    );
  }

  /** The daemon reports its own pid, so a supervisor with no unit can still watch the right target. */
  #handleFor(health: HealthView | undefined): DaemonStartHandle | undefined {
    return health === undefined ? undefined : { pid: health.pid };
  }

  async #running(owner: IDaemonSupervisor, health: HealthView | undefined): Promise<boolean> {
    if (health !== undefined) return true;
    return (await owner.inspect()).state === 'running';
  }

  /** Poll until the daemon serves HTTP, it is observed to have died, or the deadline passes. */
  async #awaitReady(owner: IDaemonSupervisor, handle: DaemonStartHandle, initiallyAlive = false): Promise<HealthView> {
    let state = beginReadinessWait(this.deps.clock.now());
    if (initiallyAlive) state = { ...state, sawAlive: true };
    while (true) {
      const health = await this.deps.health.probe();
      if (health !== undefined) return health;
      const liveness = livenessOf(await owner.inspect(handle));
      const decision = decideReadiness(state, liveness, this.deps.clock.now(), this.readiness);
      if (decision.kind === 'exited') {
        throw new DaemonStartupFailedError(
          `${this.#name} started but its process exited during startup; inspect ${this.deps.layout.logFile}`,
        );
      }
      if (decision.kind === 'timeout') {
        throw new DaemonStartupFailedError(
          `${this.#name} did not become ready within ${String(Math.round(this.readiness.deadlineMs / 1_000))}s; inspect ${this.deps.layout.logFile}`,
        );
      }
      state = decision.state;
      if (decision.kind === 'progress') {
        this.deps.out.warn(
          `${this.#name} starting — still initializing (${String(decision.elapsedSeconds)}s); waiting up to ${String(Math.round(this.readiness.deadlineMs / 1_000))}s…`,
        );
      }
      await this.deps.clock.sleep(this.readiness.cadenceMs);
    }
  }

  /** Ask the daemon to stop and confirm it actually did, escalating once a polite stop has had time. */
  async #pressStop(owner: IDaemonSupervisor, pidHint: number | undefined): Promise<void> {
    await owner.stop({ pidHint, escalate: false });
    const startedAtMs = this.deps.clock.now();
    let escalated = false;
    while (true) {
      if (await this.#down(owner, pidHint)) return;
      const decision = decideShutdown(this.deps.clock.now() - startedAtMs, escalated, this.shutdown);
      if (decision === 'give-up') {
        throw new DaemonShutdownFailedError(
          `${this.#name} did not stop within ${String(Math.round(this.shutdown.deadlineMs / 1_000))}s; inspect ${this.deps.layout.logFile}`,
        );
      }
      if (decision === 'escalate') {
        escalated = true;
        this.deps.out.warn(`${this.#name} has not stopped; escalating to an unconditional kill`);
        await owner.stop({ pidHint, escalate: true });
      }
      await this.deps.clock.sleep(this.shutdown.cadenceMs);
    }
  }

  async #down(owner: IDaemonSupervisor, pidHint: number | undefined): Promise<boolean> {
    if ((await this.deps.health.probe()) !== undefined) return false;
    const report = await owner.inspect(pidHint === undefined ? undefined : { pid: pidHint });
    return report.state !== 'running';
  }
}
