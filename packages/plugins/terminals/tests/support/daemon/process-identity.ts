import { existsSync, readFileSync } from 'node:fs';

/**
 * WHO A PROCESS IS, for a fixture that may only ever signal its own.
 *
 * A pid names a process only while that process lives: once it exits the number is reused, and a signal sent to it
 * then lands on whatever same-user process holds it now (on a box that runs live agents, somebody's tmux server).
 * So a fixture never signals a bare pid it remembered. It records an {@link ProcessIdentity} (the pid plus the start
 * time the kernel gave that process) while the process is provably its own, and {@link signalVerified} signals only
 * when the pid still carries that start time AND its command line still names the fixture's private socket.
 * A child a fixture started itself needs none of this: it holds the handle, and the handle cannot be reused.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /** The kernel's start time for the process (`/proc` ticks since boot, or `ps` `lstart` text): equal only for the same process. */
  readonly start: string;
}

/** What one process looks like from outside, or `undefined` once nothing runs under the pid. */
export interface ProcessFacts {
  readonly start: string;
  /** The process's argv, one word per element. */
  readonly argv: readonly string[];
  /** A process that has exited and only waits to be reaped counts as gone. */
  readonly defunct: boolean;
}

export type ProcessReader = (pid: number) => ProcessFacts | undefined;

/** The one place that signals; a unit test passes a recorder. */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

/**
 * The start time and state out of a `/proc/<pid>/stat` line. The command name is the one field that may hold spaces
 * and parentheses, so fields are counted from the LAST `)`: state is the first after it and start time the twentieth.
 */
export function parseProcStat(stat: string): { readonly start: string; readonly defunct: boolean } | undefined {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const state = rest[0];
  const start = rest[19];
  return state === undefined || start === undefined ? undefined : { start, defunct: state === 'Z' || state === 'X' };
}

const readProc: ProcessReader = pid => {
  try {
    const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (parsed === undefined) return undefined;
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return { ...parsed, argv };
  } catch {
    return undefined;
  }
};

/** Without `/proc` (macOS), `ps` answers the same two questions: `lstart` is the start time, `args` the argv. */
const readPs: ProcessReader = pid => {
  const asked = Bun.spawnSync(['ps', '-ww', '-o', 'stat=', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const match = /^\s*(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u.exec(asked.stdout.toString().trim());
  if (asked.exitCode !== 0 || match === null) return undefined;
  return { start: match[2] ?? '', argv: (match[3] ?? '').split(/\s+/u), defunct: (match[1] ?? '').startsWith('Z') };
};

/** The host's reader: `/proc` where there is one. */
export const hostProcessReader: ProcessReader = existsSync('/proc/self/stat') ? readProc : readPs;

/** Whether `argv` names `socket` as its private tmux socket (`-S <socket>`, or tmux's own title `... (<socket>)`). */
export function namesSocket(argv: readonly string[], socket: string): boolean {
  const at = argv.indexOf('-S');
  return (at !== -1 && argv[at + 1] === socket) || argv.some(word => word === `(${socket})`);
}

/** The identity of the live process under `pid` whose argv names `socket`; `undefined` for anything else. */
export function identify(
  pid: number,
  socket: string,
  read: ProcessReader = hostProcessReader,
): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  const facts = read(pid);
  return facts === undefined || facts.defunct || !namesSocket(facts.argv, socket)
    ? undefined
    : { pid, start: facts.start };
}

/** Whether the very process `identity` was taken from still runs. A reused pid, or a process that exited, is `false`. */
export function stillRunning(identity: ProcessIdentity, read: ProcessReader = hostProcessReader): boolean {
  const facts = read(identity.pid);
  return facts !== undefined && !facts.defunct && facts.start === identity.start;
}

/**
 * Signal `identity`'s process, only if it is still that process and still names `socket`. Answers whether a signal
 * was sent: a pid whose start time or argv no longer matches is somebody else's now and is NEVER signalled.
 */
export function signalVerified(
  identity: ProcessIdentity,
  socket: string,
  signal: NodeJS.Signals,
  deps: { readonly read?: ProcessReader; readonly send?: SignalSender } = {},
): boolean {
  const read = deps.read ?? hostProcessReader;
  const send = deps.send ?? ((pid, sent) => process.kill(pid, sent));
  const facts = read(identity.pid);
  if (facts === undefined || facts.defunct || facts.start !== identity.start || !namesSocket(facts.argv, socket))
    return false;
  try {
    send(identity.pid, signal);
    return true;
  } catch {
    return false; // Gone between the check and the signal.
  }
}
