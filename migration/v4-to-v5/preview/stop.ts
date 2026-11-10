/**
 * Stops the preview daemon without the lifecycle machinery of `fy daemon stop`, which on a box that has v4's service
 * unit installed answers for v4's unit and writes claim files beside it. This finds the process by PROOF: the pid
 * must hold the preview home's own `run/daemon.lock` open, so v4's daemon (a different lock) can never be selected.
 */
import { readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export const lockFileOf = (home: string): string => join(home, 'run', 'daemon.lock');

/** The pids that hold `lockFile` open, read from `/proc/<pid>/fd` link targets only (Linux). */
export async function pidsHolding(lockFile: string): Promise<number[]> {
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter(name => /^\d+$/u.test(name));
  const held: number[] = [];
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === lockFile) {
        held.push(Number(pid));
        break;
      }
    }
  }
  return held;
}

export interface StopPorts {
  readonly holders: (lockFile: string) => Promise<readonly number[]>;
  readonly kill: (pid: number, signal: 'SIGTERM') => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly attempts?: number;
}

/** SIGTERM every proven holder, then report whether the lock was let go. Returns a sentence and whether it stopped. */
export async function stopPreview(home: string, ports: StopPorts): Promise<{ stopped: boolean; said: string }> {
  const lockFile = lockFileOf(home);
  const pids = await ports.holders(lockFile);
  if (pids.length === 0)
    return { stopped: true, said: `no process holds ${lockFile}: the preview daemon is not running` };
  for (const pid of pids) ports.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < (ports.attempts ?? 20); attempt++) {
    await ports.sleep(500);
    if ((await ports.holders(lockFile)).length === 0)
      return { stopped: true, said: `stopped the preview daemon (pid ${pids.join(', ')}); it let go of ${lockFile}` };
  }
  return {
    stopped: false,
    said: `sent SIGTERM to pid ${pids.join(', ')} but it still holds ${lockFile}; wait, or stop that pid yourself`,
  };
}
