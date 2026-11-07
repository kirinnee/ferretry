import type { ChildEnvironment, ChildEnvironmentOpener } from '../../contract/bound.ts';
import type {
  ChildHandle,
  FetchPort,
  SpawnBytesOptions,
  SpawnBytesResult,
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
    const cwd = options?.cwd;
    // A pin is installed for exactly the one spawn statement, no await inside the bracket, and the child is given
    // `.`: it inherits the held directory and resolves `.` against it, never a name re-resolved after the fact.
    const release = cwd === undefined || typeof cwd === 'string' ? undefined : cwd.install();
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = Bun.spawn([program, ...args], {
        ...(cwd === undefined ? {} : { cwd: typeof cwd === 'string' ? cwd : '.' }),
        env: env(options),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      });
    } finally {
      release?.();
    }
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
    runBytes: async (program, args, options): Promise<SpawnBytesResult> => {
      const maxStdout = checkedLimit(options?.maxStdoutBytes, DEFAULT_STDOUT_LIMIT, 'maxStdoutBytes');
      const maxStderr = checkedLimit(options?.maxStderrBytes, DEFAULT_STDERR_LIMIT, 'maxStderrBytes');
      // The timeout is ours (SIGKILL, then stop reading): a grandchild holding the pipe cannot hang the caller.
      const { timeout, ...rest } = options ?? {};
      const child = start(program, args, rest as SpawnBytesOptions);
      let timedOut = false;
      const abandoned = Promise.withResolvers<typeof ABANDONED>();
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
              abandoned.resolve(ABANDONED);
            }, timeout);
      try {
        const [exited, stdout, stderr] = await Promise.all([
          Promise.race([child.exited, abandoned.promise]),
          readCapped(child.stdout, maxStdout, abandoned.promise),
          readCapped(child.stderr, maxStderr, abandoned.promise),
        ]);
        return {
          exitCode: exited === ABANDONED || exited === null ? -1 : exited,
          stdout: stdout.bytes,
          stderr: new TextDecoder().decode(stderr.bytes),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
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

/** Today's Git runner limits. */
export const DEFAULT_STDOUT_LIMIT = 1024 * 1024;
export const DEFAULT_STDERR_LIMIT = 64 * 1024;

function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return limit;
}

const ABANDONED = Symbol('abandoned');

/**
 * Reads at most `maxBytes`, and stops the moment `abandoned` settles (today's Git runner `readCapped`, copied).
 * Without that escape a grandchild inheriting the pipe would keep the stream open past the timeout.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abandoned: Promise<typeof ABANDONED>,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  let abandonedRead = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abandoned]);
      if (result === ABANDONED) {
        abandonedRead = true;
        break;
      }
      if (result.done) break;
      const chunk = result.value;
      // `remaining` is never negative, so an empty chunk after the cap keeps `kept` empty and is not a truncation.
      const remaining = maxBytes - keptBytes;
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      keptBytes += kept.byteLength;
      truncated ||= kept.byteLength < chunk.byteLength;
    }
  } finally {
    if (abandonedRead) await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
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
      // `workerData` carries only what the host put there (the resolved sqlite grants); `state` itself is the host's.
      const data = (options as { readonly workerData?: unknown } | undefined)?.workerData;
      const worker = new Worker(moduleUrl, {
        ...(options?.name === undefined ? {} : { name: options.name }),
        ...(data === undefined ? {} : { workerData: data }),
      } as WorkerOptions);
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
