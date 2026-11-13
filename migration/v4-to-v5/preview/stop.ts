/**
 * Stops the preview daemon without the lifecycle machinery of `fy daemon stop`, which on a box that has v4's service
 * unit installed answers for v4's unit and writes claim files beside it. This finds the process by PROOF: the pid
 * must hold the preview home's own `run/daemon.lock` open, so v4's daemon (a different lock) can never be selected.
 */
import { readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { NO_CREDS_ENV } from './driver.ts';
import { PREVIEW } from './plan.ts';

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
  /** Removes a folder or file and what it holds (no error when it is absent). */
  readonly remove: (path: string) => Promise<void>;
  readonly attempts?: number;
}

/**
 * The empty stand-ins for the host's credentials (HOME, gh, git config) that `fy5 daemon start` made. The `ssh` shim
 * (`<home>/no-host-creds/bin/ssh`) is NOT among them and is never removed here: the preview's tmux server outlives the
 * daemon, so its ferret panes keep the shim folder first on their PATH, and with the shim gone their `ssh` would be the
 * host's. A shim left after a stop is harmless (it only adds restrictions); the next daemon start replaces it atomically,
 * and `prepare` removes it with the whole preview home.
 */
const standInsOf = (home: string): string[] =>
  Object.values(NO_CREDS_ENV).map(name => join(home, PREVIEW.noCredsFolder, name));

const removeStandIns = async (home: string, ports: StopPorts): Promise<void> => {
  for (const path of standInsOf(home)) await ports.remove(path);
};

/** SIGTERM every proven holder, then report whether the lock was let go. Returns a sentence and whether it stopped. */
export async function stopPreview(home: string, ports: StopPorts): Promise<{ stopped: boolean; said: string }> {
  const lockFile = lockFileOf(home);
  const pids = await ports.holders(lockFile);
  // The empty HOME, gh folder and git config belong to one daemon start: they go when it is not running any more.
  if (pids.length === 0) {
    await removeStandIns(home, ports);
    return { stopped: true, said: `no process holds ${lockFile}: the preview daemon is not running` };
  }
  for (const pid of pids) ports.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < (ports.attempts ?? 20); attempt++) {
    await ports.sleep(500);
    if ((await ports.holders(lockFile)).length === 0) {
      await removeStandIns(home, ports);
      return { stopped: true, said: `stopped the preview daemon (pid ${pids.join(', ')}); it let go of ${lockFile}` };
    }
  }
  return {
    stopped: false,
    said: `sent SIGTERM to pid ${pids.join(', ')} but it still holds ${lockFile}; wait, or stop that pid yourself`,
  };
}
