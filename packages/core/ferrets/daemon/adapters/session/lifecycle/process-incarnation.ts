import type { HostFactsPort, SpawnPort } from '@ferretry/kernel/contract';
import {
  type ProcessIncarnation,
  procStatStartTicks,
  psStartSeconds,
} from '../../../lib/protocol/process-incarnation.ts';

/** What the incarnation source reads of the machine: the kernel's host facts, which name the platform and read `/proc`. */
export type IncarnationHostFacts = Pick<HostFactsPort, 'platform' | 'procFile'>;

/** The one program it runs: the kernel's `ps`, declared in the plugin's `permissions.spawn`. */
export type IncarnationSpawn = Pick<SpawnPort, 'run'>;

/** Linux: the kernel's start time in clock ticks, exact per incarnation. */
class ProcStatProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly host: Pick<HostFactsPort, 'procFile'>) {}

  async startOf(pid: number): Promise<number | undefined> {
    try {
      return procStatStartTicks(await this.host.procFile(pid, 'stat'));
    } catch {
      return undefined;
    }
  }
}

/**
 * macOS: the start time `ps` reads from the kernel's `kinfo_proc`, to the second.
 *
 * A second is exact enough here because macOS hands out pids in increasing order up to 99999 before
 * wrapping, so a reused pid inside the same second needs ninety-nine thousand process launches in
 * that second — and the reaper also requires the tmux pane id, which one server never reuses. `ps`
 * is run through `kernel.spawn`, which resolves the declared program itself, so a daemon's minimal
 * `PATH` can neither miss it nor be handed another.
 */
class PsProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly spawn: IncarnationSpawn) {}

  async startOf(pid: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
      const { exitCode, stdout } = await this.spawn.run('ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { LC_ALL: 'C', TZ: 'UTC0' },
      });
      return exitCode === 0 ? psStartSeconds(stdout) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Any other platform: sessions refuse to start, saying why, rather than registering an unprovable pane. */
class UnsupportedProcessIncarnation implements ProcessIncarnation {
  constructor(private readonly platform: string) {}

  async startOf(): Promise<number | undefined> {
    throw new Error(
      `sessions cannot start on ${this.platform}: Ferretry can only tell a session's process apart from a later one on Linux and macOS`,
    );
  }
}

/** The incarnation source for the platform the kernel says this daemon runs on. */
export function processIncarnationFor(host: IncarnationHostFacts, spawn: IncarnationSpawn): ProcessIncarnation {
  if (host.platform === 'linux') return new ProcStatProcessIncarnation(host);
  if (host.platform === 'darwin') return new PsProcessIncarnation(spawn);
  return new UnsupportedProcessIncarnation(host.platform);
}
