import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ISyscallTracer, SyscallTraceOutcome } from '../../lib/daemon/profile/controller.ts';
import { parseFsUsageTrace, parseStraceTrace } from '../../lib/daemon/profile/syscall-trace.ts';

/** What the tracer needs from the host; a test stands in each part. */
export interface TracerHost {
  readonly platform: string;
  readonly home: string;
  /** Whether this process may trace another of the same user without `sudo`. */
  readonly mayPtrace: () => Promise<boolean>;
  readonly which: (program: string) => string | null;
  /** Runs `argv` with the terminal attached, answering its exit code. */
  readonly interactive: (argv: readonly string[]) => Promise<number>;
  /**
   * Starts `argv` with the terminal's input attached (for a `sudo` prompt), stops it with SIGINT after
   * `seconds`, and answers what it wrote to standard output.
   */
  readonly traceFor: (
    argv: readonly string[],
    seconds: number,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Makes the file the tracer will write, inside a directory made for this one trace that nobody but
   * this user can open, and answers its path. The trace names every file and argument of the daemon, and
   * under `sudo` it is written by root, so it must never be at a name another user could have planted.
   */
  readonly scratchFile: () => Promise<string>;
  readonly readText: (path: string) => Promise<string>;
  /** Deletes the file `scratchFile` made, and the private directory it lives in. */
  readonly remove: (path: string) => Promise<void>;
}

/** Linux's ptrace policy: `0` lets a user trace any of their own processes. */
const PTRACE_SCOPE = '/proc/sys/kernel/yama/ptrace_scope';

/** Where traces are written: under the user's own state home, never the shared temporary folder. */
const TRACE_DIRECTORY = 'trace';

export const bunTracerHost = (stateHome: string): TracerHost => ({
  platform: process.platform,
  home: homedir(),
  mayPtrace: async () => {
    if (process.getuid?.() === 0) return true;
    const scope = await readFile(PTRACE_SCOPE, 'utf8').catch(() => '0');
    return scope.trim() === '0';
  },
  which: program => Bun.which(program),
  interactive: async argv =>
    await Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited,
  traceFor: async (argv, seconds) => {
    const child = Bun.spawn([...argv], { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
    const stop = setTimeout(() => child.kill('SIGINT'), seconds * 1_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(stop);
    }
  },
  scratchFile: async () => {
    const parent = join(stateHome, TRACE_DIRECTORY);
    // `mkdtemp` makes the directory `0700` and gives it a name no one can predict; the `0600` file
    // inside is made before `strace` runs, so under `sudo` root opens a file this user owns, in a
    // directory no one else can reach, instead of creating one at a name someone else chose.
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = join(await mkdtemp(join(parent, 'fy-trace-')), 'trace.txt');
    await writeFile(file, '', { mode: 0o600 });
    return file;
  },
  readText: async path => await readFile(path, 'utf8'),
  remove: async path => await rm(dirname(path), { recursive: true, force: true }),
});

/**
 * Traces the daemon's system calls from outside, for `fy daemon profile --trace-syscalls`.
 *
 * - **Linux**: `strace -f` on the daemon and its children, file calls and `execve` only. Without ptrace
 *   permission (Yama `ptrace_scope` above 0, the default on most distributions) it runs under `sudo`.
 * - **macOS**: `sudo fs_usage` on the daemon's pid, file-system and exec events. macOS has no tracer a
 *   user may run unprivileged, so it always asks for the password — once, before the window opens.
 *
 * The raw trace names every file and argument; it is parsed into shapes on this machine and deleted,
 * and only the shapes reach the report.
 */
export class PlatformSyscallTracer implements ISyscallTracer {
  #sudo = false;

  constructor(private readonly host: TracerHost) {}

  async prepare(): Promise<SyscallTraceOutcome | undefined> {
    const host = this.host;
    if (host.platform === 'linux') {
      if (host.which('strace') === null) return unavailable('strace is not installed on this machine');
      this.#sudo = !(await host.mayPtrace());
    } else if (host.platform === 'darwin') {
      this.#sudo = true;
    } else {
      return unavailable(`there is no system-call tracer for ${host.platform}`);
    }
    if (!this.#sudo) return undefined;
    if (host.which('sudo') === null) return unavailable('tracing needs sudo, and sudo is not installed');
    // `sudo -v` asks for the password now, on the terminal, and keeps it for the trace that follows.
    const code = await host.interactive(['sudo', '-v']);
    return code === 0 ? undefined : unavailable('sudo was refused, so the daemon could not be traced');
  }

  async trace(pid: number, seconds: number): Promise<SyscallTraceOutcome> {
    const host = this.host;
    const sudo = this.#sudo ? ['sudo', '-n'] : [];
    const roots = { home: host.home };
    if (host.platform === 'darwin') {
      const result = await host.traceFor(
        [...sudo, '/usr/bin/fs_usage', '-w', '-f', 'filesys', '-f', 'exec', String(pid)],
        seconds,
      );
      if (result.stdout.trim() === '')
        return unavailable(`fs_usage recorded nothing (${firstLine(result.stderr, result.code)})`);
      return { kind: 'traced', trace: parseFsUsageTrace(result.stdout, seconds, roots) };
    }
    const file = await host.scratchFile().catch(() => undefined);
    if (file === undefined) return unavailable('there was nowhere private to write the trace');
    try {
      const result = await host.traceFor(
        [...sudo, 'strace', '-f', '-qq', '-s', '256', '-e', 'trace=%file,execve', '-o', file, '-p', String(pid)],
        seconds,
      );
      const text = await host.readText(file).catch(() => '');
      if (text.trim() === '') return unavailable(`strace recorded nothing (${firstLine(result.stderr, result.code)})`);
      return { kind: 'traced', trace: parseStraceTrace(text, seconds, roots) };
    } finally {
      await host.remove(file).catch(() => undefined);
    }
  }
}

function unavailable(reason: string): SyscallTraceOutcome {
  return { kind: 'unavailable', reason };
}

function firstLine(stderr: string, code: number): string {
  const line = stderr.split('\n').find(candidate => candidate.trim() !== '');
  return line === undefined ? `exit ${String(code)}` : line.trim();
}
