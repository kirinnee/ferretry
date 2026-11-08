/**
 * `kernel.processes`' table on the real machine: today's `HostCodexAppServerProcesses`
 * (`daemon/src/adapters/process/codex-app-server-stopper.ts`), copied, with the daemon's own uid made a rule instead
 * of a side effect of what happens to be readable.
 *
 * Linux reads `/proc`, which needs no helper and is exact: a process is this user's when `/proc/<pid>` is owned by the
 * daemon's uid. macOS has no `/proc`, so it asks `ps` (`-o command=` for a command line, `-E` for the environment of
 * this user's own processes), with the `uid` column checked too; `ps` is the one the kernel resolves to an absolute
 * path (system folders first) and runs with an EMPTY environment. Any answer this cannot get is `undefined`, which the
 * rule above reads as "leave it running".
 *
 * Nothing read here is returned upward but pids and the command line `../processes.ts` compares and drops.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import type { ProcessSignalOutcome } from '../../contract/ports.ts';
import type { ProcessTable } from '../processes.ts';

/** How far up the daemon's own line of parents is walked. */
const MAX_ANCESTORS = 64;
/** How long one `ps` may take before it is killed and its answer counted unknown. */
const PS_TIMEOUT_MS = 10_000;
/** The folders `ps` is looked for in before `PATH`. */
export const PS_SYSTEM_DIRECTORIES: readonly string[] = Object.freeze(['/bin', '/usr/bin']);

/** One `ps` run: its exit code and standard output. */
export interface PsRun {
  readonly code: number;
  readonly stdout: string;
}

export interface ProcessTableOptions {
  readonly platform: NodeJS.Platform;
  /** The daemon's uid (`process.getuid()`): the only owner whose processes are answered for. */
  readonly uid: number;
  /** The daemon's own pid and its parent's. */
  readonly self: number;
  readonly parent: number;
  /** Where Linux keeps its process table. A parameter so a test can hand it a fake one. */
  readonly procRoot?: string;
  /** The uid owning a `/proc/<pid>` folder, or `undefined` when it cannot be read. Default: `stat(path).uid`. */
  readonly ownerOf?: (path: string) => Promise<number | undefined>;
  /** The absolute `ps`, or `undefined` when none is found (then every macOS answer is unknown). */
  readonly locatePs?: () => Promise<string | undefined>;
  /** Runs `argv` (an absolute `ps` first) with exactly `environment`. Default: `Bun.spawn`, no shell. */
  readonly run?: (argv: readonly string[], environment: Readonly<Record<string, string>>) => Promise<PsRun>;
  /** Sends a signal. Default: `process.kill`. Only ever called with `SIGTERM`. */
  readonly kill?: (pid: number, signal: 'SIGTERM') => void;
}

async function bunRun(argv: readonly string[], environment: Readonly<Record<string, string>>): Promise<PsRun> {
  const child = Bun.spawn([...argv], { env: { ...environment }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), PS_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

const statOwner = async (path: string): Promise<number | undefined> =>
  await stat(path).then(
    info => info.uid,
    () => undefined,
  );

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

/** The real machine's process table, for {@link processesPortFor}. */
export function hostProcessTable(options: ProcessTableOptions): ProcessTable {
  const proc = options.procRoot ?? '/proc';
  const ownerOf = options.ownerOf ?? statOwner;
  const run = options.run ?? bunRun;
  const linux = options.platform === 'linux';

  /** `ps` with these arguments, through the kernel's own absolute `ps` and an empty environment; `undefined` on any failure. */
  const ps = async (args: readonly string[]): Promise<string | undefined> => {
    const executable = await options.locatePs?.().catch(() => undefined);
    if (executable === undefined || !executable.startsWith('/')) return undefined;
    const answer = await run([executable, ...args], {}).catch(() => undefined);
    return answer?.code === 0 ? answer.stdout : undefined;
  };
  /** Whether `/proc/<pid>` is this user's. */
  const ours = async (pid: number): Promise<boolean> => (await ownerOf(`${proc}/${pid}`)) === options.uid;

  /** A Linux process's parent, from `/proc/<pid>/stat` (the field after the command's closing `)`). */
  const linuxParent = async (pid: number): Promise<number | undefined> => {
    const text = await readFile(`${proc}/${pid}/stat`, 'utf8').catch(() => undefined);
    const after =
      text === undefined
        ? undefined
        : text
            .slice(text.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/u)[1];
    const parent = after === undefined ? Number.NaN : Number(after);
    return Number.isSafeInteger(parent) ? parent : undefined;
  };
  const macParent = async (pid: number): Promise<number | undefined> => {
    const out = (await ps(['-o', 'ppid=', '-p', String(pid)]))?.trim();
    const parent = out === undefined || out === '' ? Number.NaN : Number(out);
    return Number.isSafeInteger(parent) ? parent : undefined;
  };

  return Object.freeze({
    protectedPids: async () => {
      const guarded = new Set<number>([0, 1, options.self, options.parent]);
      let current: number | undefined = options.parent;
      for (let step = 0; step < MAX_ANCESTORS && current !== undefined && current > 1; step += 1) {
        current = linux ? await linuxParent(current) : await macParent(current);
        if (current !== undefined) guarded.add(current);
      }
      return guarded;
    },
    commandLine: async (pid: number) => {
      if (linux) {
        if (!(await ours(pid))) return undefined;
        const raw = await readFile(`${proc}/${pid}/cmdline`, 'utf8').catch(() => undefined);
        // A kernel thread (or a zombie) has no command line: nothing runs from anywhere.
        const joined = raw?.replace(/\0+$/u, '').split('\0').join(' ');
        return joined === undefined || joined.trim() === '' ? undefined : joined;
      }
      const out = await ps(['-ww', '-o', 'uid=,command=', '-p', String(pid)]);
      const match = out === undefined ? null : /^\s*(\d+)\s+(.*\S)\s*$/u.exec(out);
      if (match === null || Number(match[1]) !== options.uid) return undefined;
      return match[2];
    },
    withEnvironment: async (entries: readonly string[]) => {
      if (linux) {
        const names = await readdir(proc).catch(() => undefined);
        if (names === undefined) return undefined;
        const users: number[] = [];
        for (const name of names) {
          if (!/^\d+$/u.test(name)) continue;
          const pid = Number(name);
          // Another user's process, or one that has just exited, is not ours.
          if (!(await ours(pid))) continue;
          const environ = await readFile(`${proc}/${name}/environ`, 'utf8').catch(() => undefined);
          const variables = environ?.split('\0');
          if (variables !== undefined && entries.some(entry => variables.includes(entry))) users.push(pid);
        }
        return users;
      }
      const out = await ps(['-wwEx', '-o', 'pid=,uid=,command=']);
      if (out === undefined) return undefined;
      const users: number[] = [];
      for (const line of out.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
        if (match === null || Number(match[2]) !== options.uid) continue;
        const words = (match[3] as string).split(/\s+/u);
        if (entries.some(entry => words.includes(entry))) users.push(Number(match[1]));
      }
      return users;
    },
    sigterm: async (pid: number): Promise<ProcessSignalOutcome> => {
      try {
        (options.kill ?? ((target, signal) => process.kill(target, signal)))(pid, 'SIGTERM');
        return 'signalled';
      } catch (error) {
        // Already gone between the check and the signal: the outcome somebody wanted.
        return errnoOf(error) === 'ESRCH' ? 'gone' : 'refused';
      }
    },
  });
}
