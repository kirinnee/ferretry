import { join } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
import {
  isAgentScope,
  safeUnitPart,
  sessionOfScope,
  sessionOfSlice,
  unifiedCgroupPath,
} from '../../lib/cgroups/scope.ts';
import { hostPid, hostPlatform, open, readFile, signalProcess } from '../host/fs.ts';
import { procStatStartTicks } from '../../lib/protocol/process-incarnation.ts';
import { processIncarnationFor } from '../session/processes/process-incarnation.ts';
import { parseProcStat, processTreeFor } from '../session/processes/process-tree.ts';
import type { PaneProcessHost } from './tmux-runner.ts';
import type { ProcessSnapshot } from './session-tree-end.ts';

/** More parents than any real process chain has: a cycle or a hostile procfs cannot make the walk run for ever. */
const MAX_ANCESTORS = 64;

/** The nonce varies per launch; the ferret part must be the one the launch builder would emit. */
export function scopeBelongsTo(unit: string, ferret: string): boolean {
  return isAgentScope(unit) && sessionOfScope(unit) === safeUnitPart(ferret);
}

/** A scope's own manager metadata must agree on both its name and its per-ferret parent slice. */
export function ownedScopePath(unit: string, metadata: string): string | undefined {
  const properties = new Map(
    metadata.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const slice = properties.get('Slice') ?? '';
  const ferret = sessionOfSlice(slice);
  const path = properties.get('ControlGroup') ?? '';
  if (properties.get('Id') !== unit || ferret === undefined || !scopeBelongsTo(unit, ferret)) return undefined;
  if (unifiedCgroupPath(`0::${path}`) !== path || path.split('/').at(-1) !== unit || path.split('/').at(-2) !== slice)
    return undefined;
  return path;
}

/**
 * This daemon and every parent of it, from `/proc/<pid>/stat`'s parent field where there is a procfs (Linux), else the
 * daemon and the one parent Node reports (`process.ppid`). A daemon started from inside a ferret's pane is a descendant of
 * that pane, and is exactly what a signal to a descendant must never reach. Init (1) is never a candidate either way.
 */
export async function protectedPidsOf(
  self: number = hostPid,
  procRoot: string | null = hostPlatform === 'linux' ? '/proc' : null,
  fallbackParent: number = process.ppid,
): Promise<readonly number[]> {
  const chain = [self];
  if (procRoot === null) return fallbackParent > 0 ? [self, fallbackParent] : chain;
  for (let pid = self; chain.length < MAX_ANCESTORS; ) {
    const stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf8').catch(() => undefined);
    const parent = stat === undefined ? undefined : parseProcStat(stat)?.ppid;
    if (parent === undefined || parent <= 0 || chain.includes(parent)) break;
    chain.push(parent);
    pid = parent;
  }
  // A procfs that could not be read must not leave the direct parent unprotected.
  if (chain.length === 1 && fallbackParent > 0) chain.push(fallbackParent);
  return chain;
}

/**
 * Pin the proc directory before reading anything: both stat and membership then refer to the SAME incarnation, even if
 * its numeric PID is recycled between reads. An exited proc directory fails to read; it never resolves to the new PID.
 */
async function processSnapshotOf(pid: number, procRoot = '/proc'): Promise<ProcessSnapshot | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const directory = await open(join(procRoot, String(pid)), 'r').catch(() => undefined);
  if (directory === undefined) return undefined;
  try {
    const pinned = `/proc/self/fd/${directory.fd}`;
    const stat = await readFile(join(pinned, 'stat'), 'utf8');
    const parsed = parseProcStat(stat);
    const start = procStatStartTicks(stat);
    const scope = unifiedCgroupPath(await readFile(join(pinned, 'cgroup'), 'utf8'));
    if (start === undefined || parsed === undefined || scope === undefined || ['Z', 'X'].includes(parsed.state))
      return undefined;
    // A process that left during the read is not an enumerated member either.
    if (procStatStartTicks(await readFile(join(pinned, 'stat'), 'utf8')) !== start) return undefined;
    return { pid, start, ppid: parsed.ppid, scope };
  } catch {
    return undefined;
  } finally {
    await directory.close();
  }
}

/** Enumerate identities, not bare PIDs, from an already resolved OWN scope. Every membership must match exactly. */
export async function scopeMembersOf(
  scope: string,
  procRoot = '/proc',
  cgroupRoot = '/sys/fs/cgroup',
): Promise<readonly ProcessSnapshot[]> {
  if (unifiedCgroupPath(`0::${scope}`) !== scope || !isAgentScope(scope.split('/').at(-1) ?? '')) return [];
  const procs = await readFile(join(cgroupRoot, scope, 'cgroup.procs'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const members: ProcessSnapshot[] = [];
  for (const word of procs.split('\n')) {
    const member = await processSnapshotOf(Number(word.trim()), procRoot);
    if (member !== undefined && member.scope === scope) members.push(member);
  }
  return members;
}

/** The machine reads and the one signal behind `TmuxRunner.identify` and `signalDescendant`. */
export function paneProcessHost(spawn: SpawnPort, platform: string = hostPlatform): PaneProcessHost {
  const incarnation = processIncarnationFor(platform, spawn);
  const tree = processTreeFor(spawn, platform);
  return {
    startOf: async pid => await incarnation.startOf(pid),
    tree: async root => await tree.tree(root),
    signal: signalProcess,
    protectedPids: async () => await protectedPidsOf(),
    ...(platform === 'linux'
      ? {
          processOf: async (pid: number) => await processSnapshotOf(pid),
          scopeMembers: async (unit: string) => {
            if (!isAgentScope(unit)) return [];
            const read = await spawn.run('systemctl', [
              '--user',
              'show',
              unit,
              '--property=Id',
              '--property=Slice',
              '--property=ControlGroup',
            ]);
            if (read.exitCode !== 0) {
              if (/could not be found|not loaded/iu.test(read.stderr)) return [];
              throw new Error(`could not read the recorded scope ${unit}, so its processes were not proved stopped`);
            }
            const path = ownedScopePath(unit, read.stdout);
            return path === undefined ? [] : await scopeMembersOf(path);
          },
        }
      : {}),
  };
}
