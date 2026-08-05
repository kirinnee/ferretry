import type { HealthView } from '@ferretry/protocol';
import type { DaemonLayout } from './layout.ts';
import { nixStorePathOf } from './nix-store.ts';
import type {
  DaemonSnapshot,
  DaemonStartHandle,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonSnapshotPort,
  IDaemonSupervisor,
  INixGcRootPort,
  IServiceDefinitionSupervisor,
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
  readonly snapshots: IDaemonSnapshotPort;
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
 */
export class DaemonController {
  private readonly readiness: ReadinessPolicy;
  private readonly shutdown: ShutdownPolicy;

  constructor(private readonly deps: DaemonControllerDeps) {
    this.readiness = deps.readiness ?? defaultReadinessPolicy();
    this.shutdown = deps.shutdown ?? defaultShutdownPolicy();
  }

  async install(): Promise<void> {
    const snapshot = await this.#ensurePromotedSnapshot();
    const service = this.#service();
    // Before the definition is written, so a unit file never names a store path nothing is holding.
    await this.#pinDaemonBinary(snapshot);
    await service.install(snapshot.binaryPath);
    const health = await this.#awaitReady(service, {});
    this.deps.out.success(renderInstalled(this.#name, service.definitionPath, health.pid));
  }

  async uninstall(): Promise<void> {
    const service = this.#service();
    await service.uninstall();
    // Uninstall is the ONLY verb that releases, and the asymmetry with `start` is deliberate.
    //
    // Releasing on `stop` would look tidier and is dangerously wrong: in a `nix shell`, start pins,
    // stop releases, a garbage collection runs, and the next `start` finds no executable at all —
    // manufacturing precisely the failure the pin exists to prevent, for the user who most needs it.
    // A root held too long costs one store path; a root released too early costs a working daemon.
    await this.deps.nix.release(this.deps.layout.nixGcRoot);
    this.deps.out.success(`${this.#name} user service removed`);
  }

  async start(): Promise<void> {
    const serving = await this.deps.health.probe();
    if (serving !== undefined) {
      this.deps.out.success(`${this.#name} is already serving (pid ${String(serving.pid)})`);
      return;
    }
    const owner = await this.#owner();
    const incumbent = await owner.inspect();
    if (incumbent.state === 'running') {
      // A service manager reports `activating` as running. Leave that incumbent's executable and
      // sole GC root untouched, but still honor `start`'s contract to wait until its API serves.
      const ready = await this.#awaitReady(owner, {}, true);
      this.deps.out.success(`${this.#name} ready (pid ${String(ready.pid)})`);
      return;
    }
    const snapshot = await this.#ensurePromotedSnapshot();
    await this.#pinDaemonBinary(snapshot);
    const handle = await owner.start(snapshot.binaryPath);
    const health = await this.#awaitReady(owner, handle);
    this.deps.out.success(`${this.#name} ready (pid ${String(health.pid)})`);
  }

  async stop(): Promise<void> {
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    if (!(await this.#running(owner, health))) {
      this.deps.out.warn(`${this.#name} is not running`);
      return;
    }
    await this.#pressStop(owner, health?.pid);
    this.deps.out.success(`${this.#name} stopped`);
  }

  async restart(): Promise<void> {
    // Verify the complete promoted artifact before stopping the incumbent. Damaged snapshot state
    // must leave the currently running daemon alone, not turn a repairable refusal into downtime.
    const snapshot = await this.#ensurePromotedSnapshot();
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    if (await this.#running(owner, health)) await this.#pressStop(owner, health?.pid);
    else this.deps.out.warn(`${this.#name} was not running; starting it`);
    // Restart is when an upgraded executable is picked up, so the root is re-pointed here too.
    await this.#pinDaemonBinary(snapshot);
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

  async buildSnapshot(): Promise<void> {
    const snapshot = await this.deps.snapshots.build();
    this.deps.out.success(
      `${this.#name} snapshot ${snapshot.id} ${snapshot.created ? 'built' : 'already complete'} from ${snapshot.sourceBinary}`,
    );
  }

  async promoteSnapshot(id: string): Promise<void> {
    const snapshot = await this.deps.snapshots.promote(id);
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
   * Hold the Nix-store closure a copied daemon snapshot still depends on, or say why we could not.
   *
   * `nix shell github:…` is a supported way to run this. The promoted executable is an ordinary copy,
   * but its ELF interpreter, RPATH or script interpreter can still name the Nix output recorded as
   * `sourceBinary` in its verified manifest. Any other source resolves outside the store and is left
   * alone. A failure is reported and the verb continues: an unpinned daemon that runs beats a working
   * install refused over a pin that did not take.
   */
  async #pinDaemonBinary(snapshot: DaemonSnapshot): Promise<void> {
    // The promoted executable is a copied file outside /nix/store. Its manifest records the real
    // source output whose loader and shared-library closure the copy still needs at runtime.
    const resolved = await this.deps.nix.realPath(snapshot.sourceBinary);
    const storePath = nixStorePathOf(resolved);
    if (storePath === undefined) return;
    const failure = await this.deps.nix.pin(storePath, this.deps.layout.nixGcRoot);
    if (failure === undefined) return;
    this.deps.out.warn(
      `${this.#name} snapshot was built from the Nix store but its runtime closure could not be pinned ` +
        `against garbage collection (${failure}); a later nix-collect-garbage may remove dependencies ` +
        `the snapshot needs — install with \`nix profile install\` to have Nix hold them instead`,
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

  /**
   * Bootstrap exactly once. Only a store with no durable promotion evidence takes this path;
   * `current()` throws for a lost, malformed, dangling or unverifiable pointer, so damaged evidence
   * can never be overwritten as if this were a fresh installation.
   */
  async #ensurePromotedSnapshot(): Promise<DaemonSnapshot> {
    const current = await this.deps.snapshots.current();
    if (current !== undefined) return current;
    const built = await this.deps.snapshots.build();
    const promoted = await this.deps.snapshots.promote(built.id);
    this.deps.out.warn(`no promoted ${this.#name} snapshot existed; built and promoted ${promoted.id}`);
    return promoted;
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
