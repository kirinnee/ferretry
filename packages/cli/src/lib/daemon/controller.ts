import type { HealthView } from '@ferretry/protocol';
import { planSnapshotGcRoots, type SnapshotClosure } from './gc-roots.ts';
import type { DaemonLayout } from './layout.ts';
import { nixStorePathOf } from './nix-store.ts';
import type {
  DaemonLifecycleVerb,
  DaemonSnapshot,
  DaemonStartHandle,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonSnapshotPort,
  IDaemonSupervisor,
  INixGcRootPort,
  IServiceDefinitionSupervisor,
  RetainedSnapshot,
  RetainedSnapshotInventory,
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
 * What a holder may spend outside its readiness and shutdown waits: verifying the promoted snapshot
 * and reconciling roots. A peer waits this much longer before refusing.
 */
const LIFECYCLE_RECONCILIATION_ALLOWANCE_MS = 30_000;

export class DaemonShutdownFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonShutdownFailedError';
  }
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
  readonly snapshots: IDaemonSnapshotPort;
  /** The installed daemon binary, when this invocation has one on its PATH. */
  readonly installedDaemon?: () => string | undefined;
  readonly clock: IClockPort;
  readonly out: IDaemonOutput;
  readonly readiness?: ReadinessPolicy;
  readonly shutdown?: ShutdownPolicy;
}

/**
 * Drives `fy daemon …`: installs and removes the service definition, brings the daemon up and down,
 * reports on it and streams its log.
 *
 * The daemon's own HTTP API is the authority on whether it is up, and the service manager is the
 * authority on whether it is supervised. Neither answer comes from a file under the state home — the
 * CLI does not read the daemon's state, which is the seam the whole package split exists to enforce.
 *
 * EVERY MUTATING VERB IS ONE SERIALIZED TRANSACTION, and the ones that only report are not. Each
 * mutating verb reconciles garbage-collection roots and then writes a service definition or launches
 * an executable, and those two halves have to agree about which snapshot is in play: two invocations
 * that interleave them leave a unit file naming one snapshot while the roots hold another's closure.
 * Claims keyed on every ownership target are what make the pair atomic against a peer invocation, and
 * they are taken in the public verb rather than deeper down so no verb can ever nest inside another.
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

  async start(): Promise<void> {
    await this.#serialized('start', () => this.#start());
  }

  async stop(): Promise<void> {
    await this.#serialized('stop', () => this.#stop());
  }

  async restart(): Promise<void> {
    await this.#serialized('restart', () => this.#restart());
  }

  async buildSnapshot(): Promise<void> {
    await this.#serialized('snapshot build', () => this.#buildSnapshot());
  }

  async promoteSnapshot(id: string): Promise<void> {
    await this.#serialized('snapshot promote', () => this.#promoteSnapshot(id));
  }

  async #install(): Promise<void> {
    const snapshot = await this.#ensurePromotedSnapshot();
    const service = this.#service();
    // Before the definition is written, so a unit file never names a store path nothing is holding.
    await this.#holdRetainedClosures(snapshot);
    await service.install(snapshot.binaryPath);
    const health = await this.#awaitReady(service, {});
    this.deps.out.success(renderInstalled(this.#name, service.definitionPath, health.pid));
  }

  async #uninstall(): Promise<void> {
    const service = this.#service();
    await service.uninstall();
    // REMOVING THE SERVICE DOES NOT RETIRE A SNAPSHOT, so it does not retire a snapshot's root.
    //
    // This verb used to drop the daemon's one root here, and the asymmetry with `stop` was the point:
    // in a `nix shell`, releasing on stop meant a garbage collection could leave the next `start` with
    // no executable at all. Per-snapshot roots retire the argument rather than settle it — every root
    // now belongs to a snapshot that is still sitting in the store, waiting to be promoted, and an
    // uninstalled service does not make any of them less runnable. Reconciling still runs, so a root
    // whose snapshot is genuinely gone is released; the ones that remain are named, because a held
    // store path an operator cannot account for is its own kind of surprise.
    await this.#holdRetainedClosures(undefined);
    this.deps.out.success(
      `${this.#name} user service removed; retained snapshot closures stay held in ${this.deps.layout.nixGcRootDirectory} so a rollback remains runnable`,
    );
  }

  async #start(): Promise<void> {
    const serving = await this.deps.health.probe();
    if (serving !== undefined) {
      await this.#warnIfInstalledDaemonDiffers();
      this.deps.out.success(`${this.#name} is already serving (pid ${String(serving.pid)})`);
      return;
    }
    const owner = await this.#owner();
    const incumbent = await owner.inspect();
    if (incumbent.state === 'running') {
      // A service manager reports `activating` as running. Leave that incumbent's executable and
      // sole GC root untouched, but still honor `start`'s contract to wait until its API serves.
      await this.#warnIfInstalledDaemonDiffers();
      const ready = await this.#awaitReady(owner, {}, true);
      this.deps.out.success(`${this.#name} ready (pid ${String(ready.pid)})`);
      return;
    }
    const snapshot = await this.#ensurePromotedSnapshot(true);
    await this.#holdRetainedClosures(snapshot);
    const handle = await owner.start(snapshot.binaryPath);
    const health = await this.#awaitReady(owner, handle);
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
    // Verify the complete promoted artifact AND discover every inventory problem before stopping the
    // incumbent. Reconciliation is tolerant, so a damaged sibling is a warning rather than a refusal,
    // but an operator must hear that warning while the healthy daemon is still untouched — never only
    // after restart has already created downtime.
    const snapshot = await this.#ensurePromotedSnapshot(true);
    const inventory = await this.#inventory();
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    if (await this.#running(owner, health)) await this.#pressStop(owner, health?.pid);
    else this.deps.out.warn(`${this.#name} was not running; starting it`);
    // Restart is when an upgraded executable is picked up, so the roots are reconciled here too.
    await this.#holdRetainedClosures(snapshot, inventory);
    const handle = await owner.start(snapshot.binaryPath);
    const ready = await this.#awaitReady(owner, handle);
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
    if (options.json !== true) await this.#warnIfInstalledDaemonDiffers();
    if (code !== 0) this.deps.out.setExitCode(code);
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

  async #buildSnapshot(): Promise<void> {
    const snapshot = await this.deps.snapshots.build();
    // A snapshot with no root is a rollback candidate a garbage collection can quietly disarm before
    // anybody ever promotes it, so the root exists from the moment the snapshot does. Pass the exact
    // verified build result as explicitly known protection: a tolerant but incomplete inventory may
    // omit this entry, and that uncertainty must not disarm the snapshot the command just created.
    await this.#holdRetainedClosures(snapshot);
    this.deps.out.success(
      `${this.#name} snapshot ${snapshot.id} ${snapshot.created ? 'built' : 'already complete'} from ${snapshot.sourceBinary}`,
    );
  }

  async #promoteSnapshot(id: string): Promise<void> {
    const snapshot = await this.deps.snapshots.promote(id);
    await this.#holdRetainedClosures(snapshot);
    this.deps.out.success(
      `${this.#name} snapshot ${snapshot.id} promoted; the running daemon is unchanged until the next managed launch`,
    );
  }

  async listSnapshots(options: DaemonCommandOptions): Promise<void> {
    const [snapshots, current] = await Promise.all([this.deps.snapshots.list(), this.deps.snapshots.current()]);
    const views = snapshots.map(snapshot => ({ ...snapshot, current: snapshot.id === current?.id }));
    if (options.json === true) {
      this.deps.out.success(JSON.stringify({ daemon: this.#name, snapshots: views }));
      return;
    }
    if (views.length === 0) {
      this.deps.out.warn(`no ${this.#name} snapshots have been built`);
      return;
    }
    this.deps.out.success(
      views.map(snapshot => `${snapshot.current ? '*' : ' '} ${snapshot.id}  ${snapshot.createdAt}`).join('\n'),
    );
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
   * The allowance on top is the work those two policies do not describe — verifying the promoted
   * artifact and reconciling roots — because a bound equal to the holder's best case refuses a peer
   * for no reason but the holder having been thorough.
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
   * Make the garbage-collection roots match the snapshots the store still retains.
   *
   * `nix shell github:…` is a supported way to run this. A snapshot's executable is an ordinary copy,
   * but its ELF interpreter, RPATH or script interpreter can still name the Nix output recorded as
   * `sourceBinary` in its manifest, and that output is what a root has to hold. Any other source
   * resolves outside the store and is left alone.
   *
   * Every retained snapshot is considered, not just the one being launched, because the ROLLBACK
   * candidates are the snapshots this exists to keep runnable. A failure is reported and the verb
   * continues: an unheld daemon that runs beats a working install refused over a root that did not
   * take. The superseded single root is dropped only once nothing needed a root that failed to take,
   * since while a pin is failing that old root may be the only thing holding one of these closures.
   *
   * NOTHING HERE MAY FAIL A VERB. This reconciliation is a safety net for a rollback that might happen
   * later; the daemon in front of the operator is the thing that has to keep working. Reading the
   * inventory is tolerant per entry, an inventory that is not the whole truth releases nothing at all,
   * and a store that cannot be read at all still lets the captured snapshot be held and launched.
   */
  async #holdRetainedClosures(
    launching: DaemonSnapshot | undefined,
    capturedInventory?: RetainedSnapshotInventory,
  ): Promise<void> {
    const rootDirectory = this.deps.layout.nixGcRootDirectory;
    const inventory = capturedInventory ?? (await this.#inventory());
    const closures: SnapshotClosure[] = [];
    for (const snapshot of this.#withLaunching(inventory.snapshots, launching)) {
      const resolved = await this.deps.nix.realPath(snapshot.sourceBinary);
      closures.push({ snapshotId: snapshot.id, storePath: nixStorePathOf(resolved) });
    }
    const plan = planSnapshotGcRoots({
      rootDirectory,
      closures,
      held: await this.deps.nix.held(rootDirectory),
      launching: launching?.id,
      complete: inventory.complete,
    });
    let unheld = false;
    for (const pin of plan.pin) {
      const failure = await this.deps.nix.pin(pin.storePath, pin.rootPath);
      if (failure === undefined) continue;
      unheld = true;
      this.deps.out.warn(
        `${this.#name} snapshot ${pin.snapshotId} was built from the Nix store but its runtime closure ` +
          `could not be pinned against garbage collection (${failure}); a later nix-collect-garbage may ` +
          `remove dependencies that snapshot needs — install with \`nix profile install\` to have Nix ` +
          `hold them instead`,
      );
    }
    for (const rootPath of plan.release) await this.deps.nix.release(rootPath);
    // The superseded root goes only from a run that knows the whole retained set and held all of it.
    // It is one link with no snapshot name on it, so while anything is unread or unheld it may be the
    // only thing holding a closure something still needs.
    if (!unheld && inventory.complete) await this.deps.nix.release(this.deps.layout.supersededNixGcRoot);
  }

  /**
   * The cheap retained inventory, and what to say when it is not the whole truth.
   *
   * A store that cannot be read at all is reported as an empty INCOMPLETE inventory rather than as a
   * failure, so the verb continues holding and launching what it already verified. That is the
   * difference between a damaged sibling snapshot being a warning and it being an outage: the
   * verifying listing this used to call is all-or-nothing, so one interrupted build — which no later
   * build repairs, by design — disabled every mutating verb, and `restart` stopped the daemon before
   * discovering it.
   */
  async #inventory(): Promise<RetainedSnapshotInventory> {
    const inventory = await this.deps.snapshots.retained().catch((error: unknown) => {
      return {
        snapshots: [],
        complete: false as const,
        unreadable: [
          {
            path: this.deps.layout.snapshotRoot,
            reason: `inventory read failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ] as const,
      };
    });
    for (const issue of inventory.unreadable) {
      this.deps.out.warn(`${this.#name} skipped snapshot inventory entry ${issue.path}: ${issue.reason}`);
    }
    if (!inventory.complete) {
      this.deps.out.warn(
        `${this.#name} left every garbage-collection root in place because that inventory is incomplete; ` +
          `a root is released only when its snapshot is known to be gone, and an entry that cannot be read ` +
          `is a snapshot that is still there`,
      );
    }
    return inventory;
  }

  /**
   * The snapshots a root is owed: the inventory plus the exact snapshot being launched.
   *
   * The launching snapshot is added rather than assumed present. This verb captured and verified it
   * before the inventory was read, and a snapshot that is about to be executed must be held whether
   * or not the inventory agrees about the store's contents.
   */
  #withLaunching(
    inventory: readonly RetainedSnapshot[],
    launching: DaemonSnapshot | undefined,
  ): readonly RetainedSnapshot[] {
    if (launching === undefined || inventory.some(snapshot => snapshot.id === launching.id)) return inventory;
    return [...inventory, { id: launching.id, sourceBinary: launching.sourceBinary }];
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

  /**
   * Bootstrap exactly once. Only a store with no durable promotion evidence takes this path;
   * `current()` throws for a lost, malformed, dangling or unverifiable pointer, so damaged evidence
   * can never be overwritten as if this were a fresh installation.
   */
  async #ensurePromotedSnapshot(refreshInstalled = false): Promise<DaemonSnapshot> {
    const current = await this.deps.snapshots.current();
    if (current !== undefined) {
      if (!refreshInstalled) return current;
      const installed = this.#installedDaemon();
      if (installed === undefined || installed === current.sourceBinary) return current;
      const built = await this.deps.snapshots.build();
      const promoted = await this.deps.snapshots.promote(built.id);
      this.deps.out.warn(
        `installed ${this.#name} daemon ${current.sourceBinary} differs from promoted snapshot; promoted ${promoted.sourceBinary}`,
      );
      return promoted;
    }
    const built = await this.deps.snapshots.build();
    const promoted = await this.deps.snapshots.promote(built.id);
    this.deps.out.warn(`no promoted ${this.#name} snapshot existed; built and promoted ${promoted.id}`);
    return promoted;
  }

  #installedDaemon(): string | undefined {
    try {
      return this.deps.installedDaemon?.();
    } catch (error: unknown) {
      this.deps.out.warn(
        `could not compare the installed ${this.#name} daemon; using the promoted snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  async #warnIfInstalledDaemonDiffers(): Promise<void> {
    const installed = this.#installedDaemon();
    if (installed === undefined) return;
    try {
      const current = await this.deps.snapshots.current();
      if (current !== undefined && current.sourceBinary !== installed) {
        this.deps.out.warn(
          `installed daemon ${installed} differs from promoted snapshot ${current.sourceBinary}; run fy daemon restart to apply it`,
        );
      }
    } catch (error: unknown) {
      this.deps.out.warn(
        `could not compare the installed ${this.#name} daemon; leaving the running daemon untouched: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
