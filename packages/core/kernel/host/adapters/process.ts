import type { ChildEnvironment, ChildEnvironmentOpener } from '../../contract/bound.ts';
import type {
  ChildHandle,
  FetchPort,
  SpawnOptions,
  SpawnPort,
  SpawnResult,
  WebSocketClient,
  WebSocketPort,
  WorkerHandle,
  WorkersPort,
} from '../../contract/ports.ts';

/**
 * The unrestricted spawn adapter; the host wraps it per plugin (`restrictSpawn`). The child sees the base the host
 * names plus the caller's env. A Vault `ChildEnvironment` is opened HERE, at exec time, by the bound opener, so its
 * values go straight into the child and never back to the caller (lead decision 9). A handle with no opener bound, or
 * one the opener does not recognise, refuses the start: it is never passed through as if it were plain values.
 */
export function bunSpawn(
  baseEnv: Readonly<Record<string, string>>,
  opener: () => ChildEnvironmentOpener | undefined = () => undefined,
): SpawnPort {
  const env = (options?: SpawnOptions): Record<string, string> => ({
    ...baseEnv,
    ...resolveEnv(options?.env, opener()),
  });
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

/** Plain values pass as they are; anything else must be a handle the bound opener recognises. */
export function resolveEnv(
  env: Readonly<Record<string, string>> | ChildEnvironment | undefined,
  opener: ChildEnvironmentOpener | undefined,
): Readonly<Record<string, string>> {
  if (env === undefined) return {};
  let opened: Readonly<Record<string, string>> | undefined;
  try {
    opened = opener?.open(env as ChildEnvironment);
  } catch {
    opened = undefined;
  }
  if (opened !== undefined) return opened;
  const entries = Object.entries(env as Record<string, unknown>);
  if (Object.getPrototypeOf(env) === Object.prototype && entries.every(([, value]) => typeof value === 'string'))
    return env as Readonly<Record<string, string>>;
  throw new Error('This child needs secrets the Vault did not open, so it was not started.');
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

/** Today's relay carrier dial, `new WebSocket(url)` and nothing more; the host narrows it per plugin. */
export function bunWebSockets(): WebSocketPort {
  return { connect: url => new WebSocket(url) as unknown as WebSocketClient };
}

/** The adapter a host without one gets: every dial refused, so a test can never reach the network by accident. */
export function noWebSockets(): WebSocketPort {
  return {
    connect: () => {
      throw new Error('This host opens no WebSocket connections.');
    },
  };
}
