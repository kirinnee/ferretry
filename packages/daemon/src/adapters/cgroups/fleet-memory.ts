import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_SCOPE_PREFIX,
  type CgroupHostFacts,
  FLEET_SLICE,
  type FleetMemoryPort,
  type FleetSighting,
  parseMemoryCap,
  parseMemoryEvents,
  type ScopeSighting,
  type TreeProcess,
  userManagerPath,
} from '../../lib/cgroups/index.ts';

const text = async (path: string): Promise<string | undefined> => await readFile(path, 'utf8').catch(() => undefined);

/** Pages are 4 KiB on every platform this runs on; `statm` counts pages. */
const PAGE_BYTES = 4096;
const MAX_PROCESSES = 300;

/**
 * Reads the fleet slice and each agent scope straight from the cgroup filesystem — plain async file reads,
 * no `systemctl`, no tmux, no root. The slice sits under the daemon's own user manager
 * (`.../user@UID.service/<product>-fleet.slice`), found from the daemon's own cgroup path.
 *
 * A slice that does not exist yet (nothing has launched) answers `undefined`, which is not an error.
 */
export class CgroupFleetMemory implements FleetMemoryPort {
  private readonly directory: string | undefined;

  constructor(
    host: CgroupHostFacts,
    slice: string = FLEET_SLICE,
    cgroupRoot = '/sys/fs/cgroup',
    private readonly procRoot = '/proc',
  ) {
    const manager = host.ownCgroup === undefined ? undefined : userManagerPath(host.ownCgroup);
    this.directory = manager === undefined ? undefined : join(cgroupRoot, manager, slice);
  }

  async read(): Promise<FleetSighting | undefined> {
    if (this.directory === undefined) return undefined;
    const events = parseMemoryEvents((await text(join(this.directory, 'memory.events'))) ?? '');
    if (events === undefined) return undefined;
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const scopes = (
      await Promise.all(
        names
          .filter(name => name.startsWith(AGENT_SCOPE_PREFIX) && name.endsWith('.scope'))
          .map(name => this.scope(name)),
      )
    ).filter((scope): scope is ScopeSighting => scope !== undefined);
    return { events, scopes };
  }

  async largest(scope: string): Promise<readonly TreeProcess[]> {
    if (this.directory === undefined) return [];
    const pids = (await text(join(this.directory, scope, 'cgroup.procs')))?.split('\n').filter(Boolean) ?? [];
    const processes = await Promise.all(
      pids.slice(0, MAX_PROCESSES).map(async (pid): Promise<TreeProcess | undefined> => {
        const [statm, cmdline] = await Promise.all([
          text(join(this.procRoot, pid, 'statm')),
          text(join(this.procRoot, pid, 'cmdline')),
        ]);
        const resident = Number(statm?.split(' ')[1]);
        if (!Number.isFinite(resident)) return undefined;
        return { argv: (cmdline ?? '').replaceAll('\0', ' ').trim(), rssBytes: resident * PAGE_BYTES };
      }),
    );
    return processes
      .filter((entry): entry is TreeProcess => entry !== undefined)
      .sort((a, b) => b.rssBytes - a.rssBytes);
  }

  private async scope(name: string): Promise<ScopeSighting | undefined> {
    const directory = join(this.directory as string, name);
    const events = parseMemoryEvents((await text(join(directory, 'memory.events'))) ?? '');
    if (events === undefined) return undefined;
    const current = Number((await text(join(directory, 'memory.current')))?.trim());
    const high = parseMemoryCap((await text(join(directory, 'memory.high'))) ?? '');
    return {
      scope: name,
      events,
      ...(Number.isFinite(current) ? { currentBytes: current } : {}),
      ...(high === undefined ? {} : { highBytes: high }),
    };
  }
}
