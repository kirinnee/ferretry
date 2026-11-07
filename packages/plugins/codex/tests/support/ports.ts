/**
 * Real ports for the tests that need a real child on a real pipe. Tests are exempt from `banned-globals`; this is the
 * one place they reach `Bun.spawn` and the wall clock, so a suite states which faults it injects instead of spying on
 * a global.
 */
import type { ChildHandle, Clock, SpawnOptions, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { type Duration, instantFromEpochMs } from '@ferretry/std';

export function realClock(): Clock {
  return {
    now: () => instantFromEpochMs(Date.now()),
    nowMs: () => Date.now(),
    after: (delay: Duration, fn: () => void) => {
      const timer = setTimeout(fn, delay);
      return () => clearTimeout(timer);
    },
    every: (interval: Duration, fn: () => void) => {
      const timer = setInterval(fn, Math.max(1, interval));
      return () => clearInterval(timer);
    },
    sleep: (delay: Duration) => new Promise<void>(resolve => setTimeout(resolve, delay)),
  };
}

/** The ways a platform stream can fail that a script cannot provoke. */
export interface SpawnFaults {
  /** Replace the child's stderr stream. */
  readonly stderr?: () => ReadableStream<Uint8Array>;
  /** `rejects`: the exit report fails instead of saying how the child ended. */
  readonly exitReport?: 'rejects';
  /** `broken`: every write throws the `EPIPE` a closed pipe gives. */
  readonly stdin?: 'broken';
}

export interface RealSpawn {
  readonly port: SpawnPort;
  /** Every child started, in order. */
  readonly children: ReturnType<typeof Bun.spawn>[];
}

export function realSpawn(faults: SpawnFaults = {}): RealSpawn {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    const child = Bun.spawn([program, ...args], {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    return {
      pid: child.pid,
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: faults.stderr === undefined ? (child.stderr as ReadableStream<Uint8Array>) : faults.stderr(),
      write: chunk => {
        if (faults.stdin === 'broken') throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' });
        child.stdin.write(chunk);
      },
      kill: signal => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
      // A getter: the report only fails when somebody asks for it, as a platform's does.
      get exited() {
        return faults.exitReport === 'rejects'
          ? Promise.reject(new Error('the exit report failed'))
          : child.exited.then(code => code);
      },
    };
  };
  return {
    children,
    port: {
      start,
      run: async (program, args, options): Promise<SpawnResult> => {
        const child = start(program, args, options);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { exitCode, signal: null, stdout, stderr };
      },
    },
  };
}
