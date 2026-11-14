/**
 * `kernel.hostFacts` on the real machine: each method builds its one path from checked parts (today's Terminals
 * reads, copied: the same files, `utf8`, the same throw on a missing one) and reads nothing else.
 */
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CgroupFile, HostFactsPort, HostLaunchGuard, ProcPidFile, ProcSystemFile } from '../../contract/ports.ts';
import { UNDECIDED_LAUNCH_GUARD } from './launch-guard.ts';

const SEGMENT = /^[A-Za-z0-9_.@:+-]+$/u;
const PROC_PID_FILES: ReadonlySet<ProcPidFile> = new Set([
  'stat',
  'status',
  'comm',
  'cmdline',
  'cgroup',
  'statm',
  'io',
]);
const PROC_SYSTEM_FILES: ReadonlySet<ProcSystemFile> = new Set([
  'stat',
  'meminfo',
  'sys/kernel/pid_max',
  'net/tcp',
  'net/tcp6',
]);
const CGROUP_FILES: ReadonlySet<CgroupFile> = new Set([
  'cgroup.controllers',
  'cgroup.procs',
  'memory.events',
  'memory.events.local',
  'memory.high',
  'memory.max',
  'memory.swap.max',
  'pids.max',
  'cpu.weight',
  'cpu.max',
]);

function allowedFile<T extends string>(file: T, allowed: ReadonlySet<T>): T {
  if (!allowed.has(file)) throw new RangeError('not a declared host facts file');
  return file;
}

function pidOf(pid: number | 'self'): string {
  if (pid === 'self') return 'self';
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError(`${String(pid)} is not a process id`);
  return String(pid);
}

function fdOf(fd: string): string {
  if (typeof fd !== 'string' || !/^[0-9]{1,9}$/u.test(fd)) throw new RangeError('not a descriptor number');
  return fd;
}

function cgroupPathOf(path: string): string[] {
  if (typeof path !== 'string') throw new RangeError('not a cgroup path');
  const segments = path.split('/').filter(segment => segment !== '');
  for (const segment of segments)
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..')
      throw new RangeError(`${path} is not a cgroup path`);
  return segments;
}

function deviceNumber(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${String(value)} is not a ${label} number`);
  return String(value);
}

/** The real `/proc` and `/sys`; a suite points the roots at a fixture tree. `launchGuard` is decided at boot by the kernel; left out, the guard fails closed (active). */
export function nodeHostFacts(
  roots: { readonly proc?: string; readonly sys?: string; readonly launchGuard?: () => HostLaunchGuard } = {},
): HostFactsPort {
  const proc = roots.proc ?? '/proc';
  const sys = roots.sys ?? '/sys';
  const cgroupRoot = join(sys, 'fs', 'cgroup');
  const port: HostFactsPort = {
    platform: process.platform,
    cpus: availableParallelism(),
    totalMemoryBytes: totalmem(),
    pids: async () => (await readdir(proc)).filter(name => /^[1-9][0-9]*$/u.test(name)).map(name => Number(name)),
    procFile: async (pid, file) => await readFile(join(proc, pidOf(pid), allowedFile(file, PROC_PID_FILES)), 'utf8'),
    procSystemFile: async file => await readFile(join(proc, allowedFile(file, PROC_SYSTEM_FILES)), 'utf8'),
    procTasks: async pid => await readdir(join(proc, pidOf(pid), 'task')),
    procTaskChildren: async (pid, task) =>
      await readFile(join(proc, pidOf(pid), 'task', pidOf(task), 'children'), 'utf8'),
    procFds: async pid => await readdir(join(proc, pidOf(pid), 'fd')),
    procFdLink: async (pid, fd) => await readlink(join(proc, pidOf(pid), 'fd', fdOf(fd))),
    procFdReach: async (pid, fd) => {
      const found = await stat(join(proc, pidOf(pid), 'fd', fdOf(fd)));
      return { character: found.isCharacterDevice(), device: found.rdev };
    },
    procExecutable: async pid => await readlink(join(proc, pidOf(pid), 'exe')),
    cgroupFile: async (path, file) =>
      await readFile(join(cgroupRoot, ...cgroupPathOf(path), allowedFile(file, CGROUP_FILES)), 'utf8'),
    cgroupChildren: async path => await readdir(join(cgroupRoot, ...cgroupPathOf(path))),
    blockScheduler: async (major, minor) => {
      let node = await realpath(
        join(sys, 'dev', 'block', `${deviceNumber(major, 'major')}:${deviceNumber(minor, 'minor')}`),
      );
      // A partition has no queue of its own; its parent disk does.
      const own = await readFile(join(node, 'queue', 'scheduler'), 'utf8').catch(() => undefined);
      if (own === undefined) node = dirname(node);
      const scheduler = own ?? (await readFile(join(node, 'queue', 'scheduler'), 'utf8').catch(() => ''));
      return { device: basename(node), scheduler };
    },
    launchGuard: roots.launchGuard ?? UNDECIDED_LAUNCH_GUARD,
  };
  return Object.freeze(port);
}

/** What a plugin without `permissions.hostFacts` holds: the facts are there to be named, every read refuses. */
export function undeclaredHostFacts(plugin: string, base: HostFactsPort): HostFactsPort {
  const refuse = async (): Promise<never> => {
    throw new Error(`${plugin} did not declare permissions.hostFacts, so it reads no /proc or /sys facts.`);
  };
  return Object.freeze({
    platform: base.platform,
    cpus: base.cpus,
    totalMemoryBytes: base.totalMemoryBytes,
    pids: refuse,
    procFile: refuse,
    procSystemFile: refuse,
    procTasks: refuse,
    procTaskChildren: refuse,
    procFds: refuse,
    procFdLink: refuse,
    procFdReach: refuse,
    procExecutable: refuse,
    cgroupFile: refuse,
    cgroupChildren: refuse,
    blockScheduler: refuse,
    launchGuard: () => {
      throw new Error(`${plugin} did not declare permissions.hostFacts, so it reads no launch-guard fact.`);
    },
  });
}
