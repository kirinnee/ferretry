import type { ChildHandle, FetchPort, SpawnOptions, SpawnPort, SpawnResult, WorkerHandle, WorkersPort } from '../../contract/ports.ts';

/** The unrestricted spawn adapter; the host wraps it per plugin (`restrictSpawn`). Env holds only what was named. */
export function bunSpawn(baseEnv: Readonly<Record<string, string>>): SpawnPort {
  const env = (options?: SpawnOptions): Record<string, string> => ({ ...baseEnv, ...(options?.env ?? {}) });
  const start = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    const child = Bun.spawn([program, ...args], {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      env: env(options),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
      void child.stdin.end();
    }
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      write: chunk => {
        child.stdin.write(chunk);
      },
      kill: signal => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
      exited: child.exited.then(code => code),
    };
  };
  return {
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
  };
}

export function globalFetch(): FetchPort {
  return { request: async (url, init) => await fetch(url, init) };
}

export function bunWorkers(): WorkersPort {
  return {
    start: (moduleUrl, options): WorkerHandle => {
      const worker = new Worker(moduleUrl, options?.name === undefined ? {} : { name: options.name });
      return {
        post: (message, transfer) => worker.postMessage(message, [...(transfer ?? [])]),
        onMessage: listener => {
          const handler = (event: MessageEvent): void => listener(event.data);
          worker.addEventListener('message', handler);
          return () => worker.removeEventListener('message', handler);
        },
        terminate: async () => {
          worker.terminate();
        },
      };
    },
  };
}
