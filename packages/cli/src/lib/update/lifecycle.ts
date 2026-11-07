/** The restart/install slice of today's daemon controller, using its copied supervisors and ownership checks. */
import type { DaemonLayout } from '../daemon/layout.ts';
import { nixStorePathOf } from '../daemon/nix-store.ts';
import type {
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonSupervisor,
  IServiceDefinitionSupervisor,
  INixGcRootPort,
  LocalUpdateHealth,
} from '../daemon/ports.ts';
import { launchdThrottled, servesOutsideSupervisor } from '../daemon/probe.ts';
import { decideShutdown, defaultShutdownPolicy } from '../daemon/readiness.ts';
import { UnsupportedServiceManagerError } from '../daemon/supervisor.ts';
import type { IClockPort, IDaemonOutput, InstalledDaemonBinary } from './machine.ts';
import type { IUpdateLifecyclePort } from './ports.ts';

export interface UpdateLifecycleDeps {
  readonly layout: DaemonLayout;
  readonly service: IServiceDefinitionSupervisor | undefined;
  readonly direct: IDaemonSupervisor;
  readonly locks: IDaemonLifecycleLockPort;
  readonly nix: INixGcRootPort;
  readonly clock: IClockPort;
  readonly out: IDaemonOutput;
  installed(): InstalledDaemonBinary;
  versionOf(path: string): string | undefined;
  executable(path: string): boolean;
  health(): Promise<LocalUpdateHealth | undefined>;
}

export class UpdateLifecycle implements IUpdateLifecyclePort {
  constructor(private readonly deps: UpdateLifecycleDeps) {}
  installed(): InstalledDaemonBinary {
    return this.deps.installed();
  }
  versionOf(path: string): string | undefined {
    return this.deps.versionOf(path);
  }
  executable(path: string): boolean {
    return this.deps.executable(path);
  }
  async probe(): Promise<LocalUpdateHealth | undefined> {
    return await this.deps.health();
  }

  async staleDefinition(): Promise<string | undefined> {
    const service = this.deps.service;
    if (service === undefined || !(await service.installed())) return undefined;
    return launchdThrottled(await service.inspect()) ? 'launchd ProcessType is not Interactive' : undefined;
  }

  async restart(): Promise<void> {
    // Resolve before stopping: an absent executable must never cost the incumbent its uptime.
    const daemon = this.installed();
    await this.#serialized('restart', async () => {
      const service = this.deps.service;
      const owner = service !== undefined && (await service.installed()) ? service : this.deps.direct;
      const health = await this.deps.health();
      await owner.assertServes(health?.pid);
      await this.#pin(daemon.path);
      if (owner === service && service?.restartInPlace !== undefined) {
        if (servesOutsideSupervisor(await service.inspect(), health)) await this.#stop(this.deps.direct, health);
        await service.restartInPlace(daemon.path);
      } else {
        const orphan =
          owner === service && service !== undefined && servesOutsideSupervisor(await service.inspect(), health);
        if (orphan) await this.#stop(this.deps.direct, health);
        await this.#stop(owner, orphan ? undefined : health);
        await owner.start(daemon.path);
      }
    });
  }

  async installAt(path: string): Promise<void> {
    if (!this.executable(path)) throw new Error(`${path} is not an executable file`);
    await this.#serialized('install', async () => {
      const service = this.deps.service;
      if (service === undefined) throw new UnsupportedServiceManagerError();
      const health = await this.deps.health();
      await service.assertServes(health?.pid);
      if (servesOutsideSupervisor(await service.inspect(), health)) await this.#stop(this.deps.direct, health);
      await this.#pin(path);
      await service.install(path);
    });
  }

  async #pin(path: string): Promise<void> {
    const nix = this.deps.nix;
    const store = nixStorePathOf(await nix.realPath(path));
    if (store === undefined) await nix.release(this.deps.layout.nixGcRoot);
    else {
      const failed = await nix.pin(store, this.deps.layout.nixGcRoot);
      if (failed !== undefined) this.deps.out.warn(failed);
    }
  }

  async #stop(owner: IDaemonSupervisor, health: LocalUpdateHealth | undefined): Promise<void> {
    await owner.assertServes(health?.pid);
    await owner.stop({ pidHint: health?.pid, escalate: false });
    const start = this.deps.clock.now();
    const policy = defaultShutdownPolicy();
    let escalated = false;
    while (true) {
      const report = await owner.inspect(health === undefined ? undefined : { pid: health.pid });
      if ((await this.deps.health()) === undefined && report.state !== 'running') return;
      const next = decideShutdown(this.deps.clock.now() - start, escalated, policy);
      if (next === 'give-up') throw new Error('the daemon did not stop; nothing else was started');
      if (next === 'escalate') {
        await owner.stop({ pidHint: health?.pid, escalate: true });
        escalated = true;
      }
      await this.deps.clock.sleep(policy.cadenceMs);
    }
  }

  async #serialized(verb: 'restart' | 'install', work: () => Promise<void>): Promise<void> {
    const held: IDaemonLifecycleClaim[] = [];
    try {
      for (const lockPath of this.deps.layout.lifecycleLocks)
        held.push(
          await this.deps.locks.acquire({
            lockPath,
            verb,
            waitMs: 140_000,
            waiting: holder => this.deps.out.warn(`waiting for ${holder}`),
            reclaimed: holder => this.deps.out.warn(`reclaimed the claim of ${holder}`),
          }),
        );
      await work();
    } finally {
      for (const claim of held.reverse()) {
        const failed = await claim.release();
        if (failed !== undefined) this.deps.out.warn(failed);
      }
    }
  }
}
