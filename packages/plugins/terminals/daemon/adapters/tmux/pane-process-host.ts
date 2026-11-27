import { join } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { agentScopeInPlacement } from '../../lib/cgroups/scope.ts';
import { hostPid, hostPlatform, readFile, signalProcess } from '../host/fs.ts';
import { processIncarnationFor } from '../session/processes/process-incarnation.ts';
import { parseProcStat, processTreeFor } from '../session/processes/process-tree.ts';
import type { PaneProcessHost } from './tmux-runner.ts';

/** More parents than any real process chain has: a cycle or a hostile procfs cannot make the walk run for ever. */
const MAX_ANCESTORS = 64;

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
 * Every pid in the product's agent scope that `pid` sits in, read from its own placement and that scope's `cgroup.procs`.
 * Only a scope this product named (`agentScopeInPlacement`: its prefix, one path segment) is ever read, so a pid in any other
 * cgroup answers nothing, and so does an unreadable one: a stop must never depend on a scope it cannot prove is its own.
 */
export async function scopeMembersOf(
  pid: number,
  procRoot = '/proc',
  cgroupRoot = '/sys/fs/cgroup',
): Promise<readonly number[]> {
  const placement = await readFile(join(procRoot, String(pid), 'cgroup'), 'utf8').catch(() => undefined);
  const scope = placement === undefined ? undefined : agentScopeInPlacement(placement);
  if (placement === undefined || scope === undefined) return [];
  const line = placement.split('\n').find(row => row.includes(`/${scope}`));
  const path = line?.slice(line.indexOf('/'), line.indexOf(`/${scope}`) + scope.length + 1);
  if (path === undefined || path.split('/').includes('..')) return [];
  const procs = await readFile(join(cgroupRoot, path, 'cgroup.procs'), 'utf8').catch(() => undefined);
  return (procs ?? '')
    .split('\n')
    .map(row => Number(row.trim()))
    .filter(member => Number.isSafeInteger(member) && member > 0);
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
    ...(platform === 'linux' ? { scopeMembers: async (pid: number) => await scopeMembersOf(pid) } : {}),
  };
}
