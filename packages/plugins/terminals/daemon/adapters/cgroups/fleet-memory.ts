import { readdir, readFile } from '../host/fs.ts';
import { join } from 'node:path';
import {
  AGENT_SCOPE_PREFIX,
  type AppliedCaps,
  BROWSER_SLICE,
  type CgroupHostFacts,
  FLEET_SLICE,
  type FleetMemoryPort,
  type FleetSighting,
  parseCapFile,
  parseCpuMax,
  parseMemoryCap,
  parseMemoryEvents,
  parseWeightFile,
  type ScopeSighting,
  sessionOfSlice,
  sliceCgroupPath,
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
 * (`.../user@UID.service/<product>_fleet.slice`; a dashed name nests as systemd nests it, see {@link sliceCgroupPath}), found from the daemon's own cgroup path.
 *
 * A slice that does not exist yet (nothing has launched) answers `undefined`, which is not an error.
 */
export class CgroupFleetMemory implements FleetMemoryPort {
  private readonly directory: string | undefined;

  constructor(
    private readonly host: CgroupHostFacts,
    slice: string = FLEET_SLICE,
    cgroupRoot = '/sys/fs/cgroup',
    private readonly procRoot = '/proc',
  ) {
    const manager = host.ownCgroup === undefined ? undefined : userManagerPath(host.ownCgroup);
    this.directory = manager === undefined ? undefined : join(cgroupRoot, manager, ...sliceCgroupPath(slice));
  }

  async read(): Promise<FleetSighting | undefined> {
    if (this.directory === undefined) return undefined;
    const events = parseMemoryEvents((await text(join(this.directory, 'memory.events'))) ?? '');
    if (events === undefined) return undefined;
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const localEvents = parseMemoryEvents((await text(join(this.directory, 'memory.events.local'))) ?? '');
    const browserEvents = parseMemoryEvents((await text(join(this.directory, BROWSER_SLICE, 'memory.events'))) ?? '');
    const scopes = (
      await Promise.all(
        names
          .filter(
            name =>
              sessionOfSlice(name) !== undefined || (name.startsWith(AGENT_SCOPE_PREFIX) && name.endsWith('.scope')),
          )
          .map(name => this.scope(name)),
      )
    ).filter((scope): scope is ScopeSighting => scope !== undefined);
    return {
      events,
      scopes,
      ...(localEvents === undefined ? {} : { localEvents }),
      ...(browserEvents === undefined ? {} : { browserEvents }),
      applied: await this.caps(this.directory, true),
    };
  }

  async largest(scope: string): Promise<readonly TreeProcess[]> {
    if (this.directory === undefined) return [];
    const directory = join(this.directory, scope);
    const children = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.scope'));
    const lists = await Promise.all(
      [directory, ...children.map(name => join(directory, name))].map(path => text(join(path, 'cgroup.procs'))),
    );
    const pids = [...new Set(lists.flatMap(list => list?.split('\n').filter(Boolean) ?? []))];
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

  /** What the cgroup at `directory` really holds, read from its own files. A slice also has a swap cap. */
  private async caps(directory: string, swap: boolean): Promise<AppliedCaps> {
    const [high, max, swapMax, tasks, weight, cpuMax] = await Promise.all([
      text(join(directory, 'memory.high')),
      text(join(directory, 'memory.max')),
      swap ? text(join(directory, 'memory.swap.max')) : Promise.resolve(undefined),
      text(join(directory, 'pids.max')),
      text(join(directory, 'cpu.weight')),
      text(join(directory, 'cpu.max')),
    ]);
    const field = <K extends string>(key: K, value: number | null | undefined): { [P in K]?: number | null } =>
      value === undefined ? {} : ({ [key]: value } as { [P in K]?: number | null });
    return {
      ...field('memoryHigh', high === undefined ? undefined : parseCapFile(high)),
      ...field('memoryMax', max === undefined ? undefined : parseCapFile(max)),
      ...field('swapMax', swapMax === undefined ? undefined : parseCapFile(swapMax)),
      ...field('tasksMax', tasks === undefined ? undefined : parseCapFile(tasks)),
      ...field('cpuPercent', cpuMax === undefined ? undefined : parseCpuMax(cpuMax, this.host.cpus)),
      ...(weight === undefined || parseWeightFile(weight) === undefined
        ? {}
        : { cpuWeight: parseWeightFile(weight) as number }),
    };
  }

  private async scope(name: string): Promise<ScopeSighting | undefined> {
    const directory = join(this.directory as string, name);
    // A configured slice can outlive its last scope. Only live child scopes make it a running ferret.
    if (sessionOfSlice(name) !== undefined) {
      const children = await readdir(directory).catch(() => [] as string[]);
      if (!children.some(child => child.endsWith('.scope'))) return undefined;
    }
    const events = parseMemoryEvents((await text(join(directory, 'memory.events'))) ?? '');
    if (events === undefined) return undefined;
    const current = Number((await text(join(directory, 'memory.current')))?.trim());
    const high = parseMemoryCap((await text(join(directory, 'memory.high'))) ?? '');
    return {
      scope: name,
      events,
      ...(Number.isFinite(current) ? { currentBytes: current } : {}),
      ...(high === undefined ? {} : { highBytes: high }),
      applied: await this.caps(directory, false),
    };
  }
}
