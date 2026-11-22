/**
 * The boot sweep (L42): an `ssh-agent` this daemon started and nobody stopped.
 *
 * A clean stop kills every agent. An UNCLEAN death (SIGKILL, power loss of the daemon alone, an OOM kill) leaves each one
 * running, still holding its account's key in memory, behind a socket in this plugin's private folder. The next daemon
 * unlinks that socket and binds a new agent at the same path, so the old process would run on for good with no way left
 * to reach it. This finds those processes and ends them BEFORE any new agent starts.
 *
 * What is ever signalled is decided by three facts that must ALL hold, so a stranger's `ssh-agent` is never touched:
 *
 * - its command line is exactly what {@link AgentSupervisor} starts: `ssh-agent -D -a <this folder>/gha_<digits>.sock`
 *   (the folder is this daemon's own private `downloads` folder, so another daemon, another install and the person's
 *   own login agent have other paths);
 * - its owner is this daemon's own uid;
 * - it is not this daemon, nor pid 0 or 1.
 *
 * Signalled by pid and by SIGTERM only; nothing is matched by name alone. A table that cannot be read ends the sweep
 * with a warning (nothing is guessed).
 */
import type { Clock, Log } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { GitAccountId } from '../../../contract/index.ts';

/** One process of the host's table. */
export interface AgentProcess {
  readonly pid: number;
  readonly uid: number;
  /** The whole command line, arguments joined by one space. */
  readonly args: string;
}

/** The host's process table, and the one signal the sweep sends. */
export interface AgentProcessTable {
  /** Every process the host can list; `undefined` when it cannot be listed. */
  list(): Promise<readonly AgentProcess[] | undefined>;
  /** SIGTERM to one pid; `false` when it was already gone or may not be signalled. */
  terminate(pid: number): boolean;
}

/** What the sweep needs besides the table: whose processes are this daemon's, and which one is the daemon itself. */
export interface LeftoverAgents {
  readonly table: AgentProcessTable;
  /** This daemon's uid; `-1` (it has none) matches nobody. */
  readonly uid: number;
  /** This daemon's own pid. */
  readonly self: number;
}

/** The longest the killed agents are waited for: each removes its own socket path as it exits. */
const GONE_WAIT_MS = 3_000;
const GONE_POLL_MS = 50;
const SOCKET_NAME = /^(gha_[0-9]{1,20})\.sock$/u;

/** The account whose agent `args` is, when it is exactly an agent this plugin starts in `folder`; otherwise `undefined`. */
export function ownAgentAccount(args: string, folder: string): GitAccountId | undefined {
  const space = args.indexOf(' ');
  if (space < 1) return undefined;
  const program = args.slice(0, space);
  if (program.slice(program.lastIndexOf('/') + 1) !== 'ssh-agent') return undefined;
  const flags = `-D -a ${folder}/`;
  const rest = args.slice(space + 1);
  if (!rest.startsWith(flags)) return undefined;
  const name = rest.slice(flags.length);
  // A name only: a path that goes anywhere else (a slash, a `..`) is not this plugin's.
  return SOCKET_NAME.exec(name)?.[1] as GitAccountId | undefined;
}

export interface SweepPorts {
  readonly leftovers: LeftoverAgents;
  /** The agents' folder (the one every socket lives in). */
  readonly folder: string;
  /** Removes one name from that folder; nothing when it is not there. */
  readonly remove: (name: string) => Promise<void>;
  readonly clock: Pick<Clock, 'sleep'>;
  readonly log: Pick<Log, 'warn'>;
}

/** Ends this daemon's leftover agents and removes their sockets. Never throws; answers how many agents it ended. */
export async function sweepLeftoverAgents(ports: SweepPorts): Promise<number> {
  const { table, uid, self } = ports.leftovers;
  try {
    const ours = (processes: readonly AgentProcess[] | undefined) =>
      (processes ?? []).filter(
        entry =>
          entry.uid === uid &&
          entry.pid > 1 &&
          entry.pid !== self &&
          ownAgentAccount(entry.args, ports.folder) !== undefined,
      );
    const listed = await table.list();
    if (listed === undefined) {
      ports.log.warn(
        'git-accounts: the process list could not be read, so agents left by an earlier run were not looked for',
      );
      return 0;
    }
    const found = ours(listed);
    if (found.length === 0) return 0;
    const ended = found.filter(entry => table.terminate(entry.pid));
    // Each agent removes its own socket as it exits, and would remove a NEW agent's at that path: wait until they are gone.
    const pids = new Set(ended.map(entry => entry.pid));
    for (let waited = 0; waited < GONE_WAIT_MS && pids.size > 0; waited += GONE_POLL_MS) {
      const still = new Set(ours(await table.list()).map(entry => entry.pid));
      for (const pid of [...pids]) if (!still.has(pid)) pids.delete(pid);
      if (pids.size > 0) await ports.clock.sleep(milliseconds(GONE_POLL_MS)).catch(() => undefined);
    }
    for (const entry of found) {
      const account = ownAgentAccount(entry.args, ports.folder) as GitAccountId;
      await ports.remove(`${account}.sock`).catch(() => undefined);
      ports.log.warn('git-accounts: an agent left behind by an earlier run was stopped', { account });
    }
    return ended.length;
  } catch {
    ports.log.warn('git-accounts: agents left by an earlier run could not be swept');
    return 0;
  }
}
