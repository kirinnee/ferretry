/**
 * The host's process table for the boot sweep (`../features/ssh-keys/sweep.ts`): a listing, a fresh read of one pid, and
 * SIGTERM by pid.
 *
 * A bare `ps` on the daemon's `PATH` is NEVER run: that `PATH` can name a shim folder or another install's shims, and a
 * planted `ps` could name any same-user pid as "ours" so the sweep would signal it.
 *
 * - Linux reads `/proc/<pid>/cmdline` and `/proc/<pid>/status` directly: nothing is run at all.
 * - Elsewhere (macOS) `ps` is the ABSOLUTE system one (`/bin/ps`, `/usr/bin/ps`, as the kernel's own Codex stopper does),
 *   run sealed through the kernel's spawn; none of them present answers `undefined` and the sweep does nothing.
 */
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { AgentProcess, AgentProcessTable } from '../features/ssh-keys/sweep.ts';

const PS_TIMEOUT_MS = 10_000;
/** `<pid> <uid> <command line>`: the three columns asked for, no header. */
const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u;
/** `Uid:\t<real>\t<effective>\t<saved>\t<fs>` of `/proc/<pid>/status`. */
const STATUS_UID = /^Uid:\s+(\d+)\s+(\d+)/mu;
/** The only places a macOS `ps` is taken from. */
const SYSTEM_PS: readonly string[] = Object.freeze(['/bin/ps', '/usr/bin/ps']);

/** Parses `ps -o pid=,uid=,args=` output; a line that is not three columns is skipped. */
export function parsePsListing(text: string): readonly AgentProcess[] {
  const out: AgentProcess[] = [];
  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (match !== null) out.push({ pid: Number(match[1]), uid: Number(match[2]), args: match[3] as string });
  }
  return out;
}

export interface AgentProcessOptions {
  /** Default `process.platform`. A parameter so a test can answer for the other family. */
  readonly platform?: NodeJS.Platform;
  /** Where Linux keeps its process table (default `/proc`): a test hands it a fake folder. */
  readonly procRoot?: string;
  /** The absolute `ps` candidates, in order (default {@link SYSTEM_PS}). */
  readonly systemPs?: readonly string[];
  /** Default `process.kill`; only ever called with `SIGTERM`. */
  readonly kill?: (pid: number, signal: 'SIGTERM') => void;
}

/** One `/proc/<pid>`: its whole command line (arguments joined by one space) and its owner; `undefined` for anything unreadable, empty, or whose real and effective uid differ. */
async function procEntry(root: string, pid: number): Promise<AgentProcess | undefined> {
  try {
    const raw = await readFile(`${root}/${pid}/cmdline`, 'utf8');
    const args = raw.replace(/\0+$/u, '').split('\0').join(' ').trim();
    // A kernel thread or a zombie has no command line: nothing runs from anywhere.
    if (args === '') return undefined;
    const status = STATUS_UID.exec(await readFile(`${root}/${pid}/status`, 'utf8'));
    if (status === null || status[1] !== status[2]) return undefined;
    return { pid, uid: Number(status[1]), args };
  } catch {
    return undefined;
  }
}

/** The first system `ps` that is a plain executable file, or `undefined` (never a bare name, never `PATH`). */
async function locateSystemPs(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here: the next one
    }
  }
  return undefined;
}

/**
 * Lists and reads from `/proc` on Linux and from the absolute system `ps` elsewhere (`-ww -axo`; `-ww` keeps a long
 * command line whole), signals with `process.kill`. A table that cannot be read answers `undefined` and the sweep does
 * nothing.
 */
export function psAgentProcesses(spawn: Pick<SpawnPort, 'run'>, options: AgentProcessOptions = {}): AgentProcessTable {
  const linux = (options.platform ?? process.platform) === 'linux';
  const proc = options.procRoot ?? '/proc';
  const kill = options.kill ?? ((pid: number, signal: 'SIGTERM') => process.kill(pid, signal));
  const ps = async (args: readonly string[]): Promise<string | undefined> => {
    const program = await locateSystemPs(options.systemPs ?? SYSTEM_PS);
    if (program === undefined) return undefined;
    try {
      const result = await spawn.run(program, args, { sealed: true, timeout: milliseconds(PS_TIMEOUT_MS) });
      return result.exitCode === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    list: async () => {
      if (linux) {
        const names = await readdir(proc).catch(() => undefined);
        if (names === undefined) return undefined;
        const found = await Promise.all(
          names.filter(name => /^\d+$/u.test(name)).map(name => procEntry(proc, Number(name))),
        );
        return found.filter((entry): entry is AgentProcess => entry !== undefined);
      }
      const text = await ps(['-ww', '-axo', 'pid=,uid=,args=']);
      return text === undefined ? undefined : parsePsListing(text);
    },
    read: async pid => {
      if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
      if (linux) return await procEntry(proc, pid);
      const text = await ps(['-ww', '-o', 'pid=,uid=,args=', '-p', String(pid)]);
      return text === undefined ? undefined : parsePsListing(text).find(entry => entry.pid === pid);
    },
    terminate: pid => {
      // Only ever a pid the sweep matched by command line and uid: never 0, never 1 (a negative pid would signal a group).
      if (!Number.isSafeInteger(pid) || pid <= 1) return false;
      try {
        kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    },
  };
}
