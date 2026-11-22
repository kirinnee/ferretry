/** The host's process table for the boot sweep (`../features/ssh-keys/sweep.ts`): one `ps` listing, and SIGTERM by pid. */
import type { SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { AgentProcess, AgentProcessTable } from '../features/ssh-keys/sweep.ts';

const PS_TIMEOUT_MS = 10_000;
/** `<pid> <uid> <command line>`: the three columns asked for, no header. */
const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u;

/** Parses `ps -o pid=,uid=,args=` output; a line that is not three columns is skipped. */
export function parsePsListing(text: string): readonly AgentProcess[] {
  const out: AgentProcess[] = [];
  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (match !== null) out.push({ pid: Number(match[1]), uid: Number(match[2]), args: match[3] as string });
  }
  return out;
}

/**
 * Lists with `ps` (Linux procps and macOS both take `-ww -axo`; `-ww` keeps a long command line whole), signals with
 * `process.kill`. `ps` runs sealed, through the kernel's spawn, so it needs the manifest's `spawn` entry; a host without
 * one, or a listing that fails, answers `undefined` and the sweep does nothing.
 */
export function psAgentProcesses(spawn: Pick<SpawnPort, 'run'>): AgentProcessTable {
  return {
    list: async () => {
      try {
        const result = await spawn.run('ps', ['-ww', '-axo', 'pid=,uid=,args='], {
          sealed: true,
          timeout: milliseconds(PS_TIMEOUT_MS),
        });
        return result.exitCode === 0 ? parsePsListing(result.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    terminate: pid => {
      // Only ever a pid the sweep matched by command line and uid: never 0, never 1 (a negative pid would signal a group).
      if (!Number.isSafeInteger(pid) || pid <= 1) return false;
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    },
  };
}
