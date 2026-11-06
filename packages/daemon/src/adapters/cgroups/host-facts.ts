import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  type AncestorCap,
  ancestorPaths,
  type CgroupHostFacts,
  memoryCeiling,
  ownCgroupPath,
  parseMemoryCap,
  parseSwapTotal,
} from '../../lib/cgroups/index.ts';

/** Where the kernel publishes what is read; overridable so a test can use a temporary tree. */
export interface HostFactPlaces {
  readonly cgroupRoot: string;
  readonly proc: string;
  /** Where systemd keeps unit drop-ins, lowest priority first. */
  readonly systemd: readonly string[];
}

const DEFAULT_PLACES: HostFactPlaces = {
  cgroupRoot: '/sys/fs/cgroup',
  proc: '/proc',
  systemd: ['/etc/systemd/system', '/run/systemd/system'],
};

const text = async (path: string): Promise<string | undefined> => await readFile(path, 'utf8').catch(() => undefined);

const SETTING: Readonly<Record<AncestorCap['file'], RegExp>> = {
  'memory.high': /^\s*MemoryHigh\s*=/mu,
  'memory.max': /^\s*MemoryMax\s*=/mu,
};

/**
 * Which unit holds the budget down, and the drop-in file that sets it, when one can be found: the LAST
 * `*.conf` (systemd reads them in name order, a later one winning) under `<unit>.d` that sets that limit.
 * A cap set some other way (a unit file, `set-property`) has no drop-in, and the unit alone is said.
 */
async function capOrigin(cap: AncestorCap, places: HostFactPlaces): Promise<CgroupHostFacts['ceilingCap']> {
  const unit = cap.path.split('/').filter(Boolean).at(-1) ?? '';
  let dropIn: string | undefined;
  for (const root of places.systemd) {
    const directory = join(root, `${unit}.d`);
    const names = ((await readdir(directory).catch(() => [])) as string[])
      .filter(name => name.endsWith('.conf'))
      .sort();
    for (const name of names)
      if (SETTING[cap.file].test((await text(join(directory, name))) ?? '')) dropIn = join(directory, name);
  }
  return { unit, file: cap.file, ...(dropIn === undefined ? {} : { dropIn }) };
}

/**
 * What the machine this daemon is running on can do, measured once at boot — ASYNCHRONOUSLY, because the
 * daemon's one thread is the thing these limits exist to keep responsive.
 *
 * MEASURED ONCE ON PURPOSE. A host does not grow CPUs while a daemon runs, and reading the values per
 * request would let two derivations of the same percentage disagree.
 *
 * THE MEMORY CEILING is the smallest of the physical RAM and every finite `memory.max` / `memory.high` on
 * the daemon's own ancestor cgroups (`/proc/self/cgroup` names the path, `/sys/fs/cgroup/<path>` holds the
 * files). That is the budget the kernel actually enforces on this daemon's own thread — see
 * `lib/cgroups/ceiling.ts`. `availableParallelism` rather than the raw CPU count: it honours the affinity
 * mask this daemon was started with.
 */
export async function hostCgroupFacts(
  now: { readonly platform: string; readonly cpus: number; readonly physicalBytes: number } = {
    platform: process.platform,
    cpus: availableParallelism(),
    physicalBytes: totalmem(),
  },
  places: HostFactPlaces = DEFAULT_PLACES,
): Promise<CgroupHostFacts> {
  const physicalBytes = Math.max(1, Math.floor(now.physicalBytes));
  const base = { platform: now.platform, cpus: Math.max(1, Math.floor(now.cpus)), physicalBytes };
  if (now.platform !== 'linux')
    return {
      ...base,
      unifiedHierarchy: false,
      memoryCeilingBytes: physicalBytes,
      ceilingSource: 'the machine’s memory',
      swapBytes: 0,
    };
  const unified = (await text(join(places.cgroupRoot, 'cgroup.controllers'))) !== undefined;
  const own = unified ? ownCgroupPath((await text(join(places.proc, 'self', 'cgroup'))) ?? '') : undefined;
  const caps: AncestorCap[] = [];
  if (own !== undefined)
    for (const path of ancestorPaths(own))
      for (const file of ['memory.max', 'memory.high'] as const) {
        const bytes = parseMemoryCap((await text(join(places.cgroupRoot, path, file))) ?? '');
        if (bytes !== undefined) caps.push({ path, file, bytes });
      }
  const ceiling = memoryCeiling(physicalBytes, caps);
  const ceilingCap = ceiling.cap === undefined ? undefined : await capOrigin(ceiling.cap, places);
  const swapBytes = parseSwapTotal((await text(join(places.proc, 'meminfo'))) ?? '');
  const pidMaxText = (await text(join(places.proc, 'sys', 'kernel', 'pid_max')))?.trim();
  const pidMax = pidMaxText !== undefined && /^\d+$/u.test(pidMaxText) ? Number(pidMaxText) : undefined;
  return {
    ...base,
    unifiedHierarchy: unified,
    memoryCeilingBytes: ceiling.bytes,
    ceilingSource: ceiling.source,
    swapBytes,
    ...(pidMax === undefined ? {} : { pidMax }),
    ...(ceilingCap === undefined ? {} : { ceilingCap }),
    ...(own === undefined ? {} : { ownCgroup: own }),
  };
}

/**
 * The host as far as the standard library alone can tell, for a world built without measuring (tests,
 * `--check`): the machine's own memory is the budget and no cgroup hierarchy is claimed, so nothing
 * would be enforced from it. The running daemon measures with {@link hostCgroupFacts} instead.
 */
export function unmeasuredHostFacts(): CgroupHostFacts {
  const physicalBytes = Math.max(1, Math.floor(totalmem()));
  return {
    platform: process.platform,
    unifiedHierarchy: false,
    cpus: Math.max(1, Math.floor(availableParallelism())),
    physicalBytes,
    memoryCeilingBytes: physicalBytes,
    ceilingSource: 'the machine’s memory',
    swapBytes: 0,
  };
}
