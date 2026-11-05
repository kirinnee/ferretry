/**
 * The owner's login shell, asked for its environment (`../../lib/fleet/shell-environment.ts` owns what is
 * asked and how the answer is read; this owns the process).
 *
 * The process is started with a fixed argv and a small, fixed environment — the account's own `HOME`,
 * `USER`, `LOGNAME`, `SHELL`, a `PATH` and the locale, with `TERM=dumb` — so what comes back is what the
 * person's rc files set, not what this daemon happened to inherit. stdin is `/dev/null`, stdout is a
 * pipe and stderr is discarded unread. It is started in a process group of its own and the WHOLE group is
 * SIGKILLed when the time is up or the answer is in — an rc file that backgrounds a program (an agent, a
 * version manager's helper) must not outlive the read — and output past a fixed cap is not read. Nothing it prints is ever logged: the parse keeps only the names it is told to keep.
 */
import type { ShellEnvironmentReading } from '@ferretry/fleet';
import {
  parseShellEnvironment,
  SHELL_ENVIRONMENT_MAX_BYTES,
  SHELL_ENVIRONMENT_TIMEOUT_MS,
  type ShellEnvironmentPort,
  shellEnvironmentArgv,
} from '../../lib/fleet/shell-environment.ts';
import type { LoginShellPort } from '../../lib/terminal/login-shell.ts';

/** One started shell: its output, its end, and a way to stop it. */
export interface ShellProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal: 'SIGKILL'): void;
}

/** Starts one shell. Throws when it cannot be started at all. */
export type ShellSpawn = (input: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}) => ShellProcess;

export interface LoginShellEnvironmentDeps {
  readonly shell: LoginShellPort;
  readonly spawn: ShellSpawn;
  /** The environment the shell starts from; `SHELL` is the shell itself and `TERM` is `dumb`, whatever this says. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * How long output is still read once the shell has exited. A program an rc file started in the
   * background can hold the pipe open forever; what the shell itself wrote is already in it.
   */
  readonly drainMs?: number;
}

const DEFAULT_DRAIN_MS = 250;

type Ended = { readonly kind: 'ended' } | { readonly kind: 'timeout' } | { readonly kind: 'too-large' };

export class LoginShellEnvironment implements ShellEnvironmentPort {
  constructor(private readonly deps: LoginShellEnvironmentDeps) {}

  async read(keep: (name: string) => boolean): Promise<ShellEnvironmentReading> {
    const timeoutMs = this.deps.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS;
    const maxBytes = this.deps.maxBytes ?? SHELL_ENVIRONMENT_MAX_BYTES;
    let child: ShellProcess;
    try {
      const shell = await this.deps.shell.shell();
      child = this.deps.spawn({
        argv: shellEnvironmentArgv(shell),
        env: { ...this.deps.env, SHELL: shell, TERM: 'dumb' },
        cwd: this.deps.cwd,
      });
    } catch {
      return { state: 'unavailable', cause: 'failed' };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = child.stdout.getReader();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = (ms: number, ended: Ended): Promise<Ended> =>
      new Promise(resolve => {
        timers.push(setTimeout(() => resolve(ended), ms));
      });
    const drained = (async (): Promise<Ended> => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return { kind: 'ended' };
        bytes += next.value.byteLength;
        if (bytes > maxBytes) return { kind: 'too-large' };
        chunks.push(next.value);
      }
    })().catch((): Ended => ({ kind: 'ended' }));
    const exitedThenDrained = child.exited.then(
      async () => await Promise.race([drained, after(this.deps.drainMs ?? DEFAULT_DRAIN_MS, { kind: 'ended' })]),
      (): Ended => ({ kind: 'ended' }),
    );
    const ended = await Promise.race([drained, exitedThenDrained, after(timeoutMs, { kind: 'timeout' })]);
    for (const timer of timers) clearTimeout(timer);
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    reader.cancel().catch(() => undefined);
    if (ended.kind === 'timeout') return { state: 'unavailable', cause: 'timed-out' };
    if (ended.kind === 'too-large') return { state: 'unavailable', cause: 'failed' };
    const output = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, bytes));
    const env = parseShellEnvironment(output, keep);
    return env === undefined ? { state: 'unavailable', cause: 'failed' } : { state: 'read', env };
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(
    Math.min(
      length,
      chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    ),
  );
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * The real spawn: stdin `/dev/null`, stdout a pipe, stderr discarded unread, and a process group (and
 * session) of its own, so `kill` reaches everything the shell's rc files started, not only the shell.
 */
export const bunShellSpawn: ShellSpawn = input => {
  const child = Bun.spawn({
    cmd: [...input.argv],
    env: { ...input.env },
    cwd: input.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    detached: true,
  });
  return {
    stdout: child.stdout,
    exited: child.exited,
    kill: signal => {
      try {
        // A negative pid is the group the child leads; the shell alone is the fallback.
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
};

/** The variables of this daemon's environment a login shell needs to find its own rc files, and no others. */
const SHELL_BASE_NAMES = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'XDG_RUNTIME_DIR'];

/** The environment a login shell is started from: the account's own few, never what the daemon inherited. */
export function loginShellBaseEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of SHELL_BASE_NAMES) {
    const value = environment[name];
    if (value !== undefined && value !== '') base[name] = value;
  }
  base.HOME = home;
  base.PATH ??= '/usr/bin:/bin:/usr/sbin:/sbin';
  return base;
}
