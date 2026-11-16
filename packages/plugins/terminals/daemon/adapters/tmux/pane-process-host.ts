import { join } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
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

/** The machine reads and the one signal behind `TmuxRunner.identify` and `signalDescendant`. */
export function paneProcessHost(spawn: SpawnPort, platform: string = hostPlatform): PaneProcessHost {
  const incarnation = processIncarnationFor(platform, spawn);
  const tree = processTreeFor(spawn, platform);
  return {
    startOf: async pid => await incarnation.startOf(pid),
    tree: async root => await tree.tree(root),
    signal: signalProcess,
    protectedPids: async () => await protectedPidsOf(),
  };
}
