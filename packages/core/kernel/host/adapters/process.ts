import { close as closeDescriptor } from 'node:fs';
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
import { detachedAsked, detachedHandle, plainEnvironment } from '../detached.ts';
import { embeddedWorkerUrl } from './embedded-worker.ts';

/**
 * The unrestricted spawn adapter; the host wraps it per plugin (`restrictSpawn`). The child sees the base the host
 * names plus the caller's env. A Vault `ChildEnvironment` is opened HERE, at exec time, by the bound opener, so its
 * values go straight into the child and never back to the caller (lead decision 9). A handle with no opener bound, or
 * one the opener does not recognise, refuses the start: it is never passed through as if it were plain values.
 */
/**
 * The spawn call a detached start makes (`Bun.spawn` in the daemon); a unit test passes a recorder instead, so it
 * can see `detached: true` and the ignored streams reach the call and `unref` run, with no real orphan left behind.
 */
export type DetachedSpawnCall = (
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin: 'ignore';
    readonly stdout: 'ignore';
    readonly stderr: 'ignore';
    readonly detached: true;
  },
) => { readonly pid: number; unref(): void };

const bunDetachedSpawn: DetachedSpawnCall = (argv, options) =>
  Bun.spawn([...argv], { ...options, env: { ...options.env } });

/**
 * A detached start (`SpawnOptions.detached`): its own session and process group (Bun's `detached` is `setsid`), all
 * three streams ignored, unreferenced so the daemon never waits on it. The gate (`allowDetachedSpawn`) already refused
 * every option a detached child cannot carry; this refuses them again so the adapter alone never starts one with a
 * pipe, a held folder or a secret environment.
 */
export function startDetached(
  program: string,
  args: readonly string[],
  options: SpawnOptions,
  env: (program: string, options?: SpawnOptions) => Record<string, string>,
  call: DetachedSpawnCall = bunDetachedSpawn,
): ChildHandle {
  const cwd = options.cwd;
  if (
    options.extraPipes !== undefined ||
    options.stdin !== undefined ||
    options.forFerret !== undefined ||
    options.timeout !== undefined ||
    options.signal !== undefined ||
    (cwd !== undefined && typeof cwd !== 'string') ||
    (options.env !== undefined && !plainEnvironment(options.env))
  )
    throw new Error(
      'A detached child takes no pipes, stdin, ferret, timeout, signal, held folder or secret environment.',
    );
  const child = call([program, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: env(program, options),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  child.unref();
  return detachedHandle(child.pid);
}

/** Bun's `signalCode` as text: its name (`'SIGTERM'`), and `null` for a child no signal ended. */
const signalName = (code: string | number | null): string | null => (code === null ? null : String(code));

/** The most extra pipes one child may have (Chrome's DevTools pipe needs two). */
const MAX_EXTRA_PIPES = 4;

/**
 * The NON-secret environment names `git` and `gh` children are given from the daemon's own environment, so a
 * keyring-backed `gh` (the session bus and runtime directory), its own config folder, an ssh agent for clones and an
 * operator's proxy keep working. Every other name, and every token (`GH_TOKEN`, `GITHUB_TOKEN`, ...), stays out: a
 * name is added here only when it can hold no credential of its own (the proxy variables are the one known exception: see docs/secrets.md).
 */
export const TOOL_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/**
 * The ONLY names a SEALED child (`SpawnOptions.sealed`) inherits from the daemon, by name: v4's allowlist
 * (`bun-secret-child-runner.ts`). An allowlist, not a filter: the daemon loads its own configured secrets into its own
 * environment, and none of them, nor the proxy credentials of {@link TOOL_ENVIRONMENT_NAMES}, may reach a child whose output
 * a copy's masking cannot see into.
 */
export const SEALED_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
]);

/** The sealed names that are set in `source`: nothing else of it is copied. */
export function sealedEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of SEALED_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (typeof value === 'string') picked[name] = value;
  }
  return picked;
}

/** What `realAdapters` is given besides the plain base: the tool overlay and the sealed allowlist, both from one source. */
export function childEnvironments(source: Readonly<Record<string, string | undefined>>): {
  readonly toolEnv: Record<string, string>;
  readonly sealedEnv: Record<string, string>;
} {
  return { toolEnv: toolEnvironment(source), sealedEnv: sealedEnvironment(source) };
}

/** The programs that are given {@link TOOL_ENVIRONMENT_NAMES}. */
const TOOL_PROGRAMS: ReadonlySet<string> = new Set(['git', 'gh']);

/** The allow-listed names that are set in `source`: nothing else of it is copied. */
export function toolEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of TOOL_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (typeof value === 'string' && value !== '') picked[name] = value;
  }
  return picked;
}

/**
 * What a child sees: the host's base, the allow-listed tool environment when the program is `git` or `gh`, then the
 * caller's own env (which wins). A token the caller hands over is the caller's act; the host adds none.
 */
export function childEnvironment(
  program: string,
  baseEnv: Readonly<Record<string, string>>,
  tools: Readonly<Record<string, string>>,
  extra: Record<string, string>,
): Record<string, string> {
  const name = program.slice(program.lastIndexOf('/') + 1);
  return { ...baseEnv, ...(TOOL_PROGRAMS.has(name) ? tools : {}), ...extra };
}

export function bunSpawn(
  baseEnv: Readonly<Record<string, string>>,
  opener: () => ChildEnvironmentOpener | undefined = () => undefined,
  tools: Readonly<Record<string, string>> = {},
  /** What a SEALED child inherits ({@link sealedEnvironment}); absent, a sealed child sees only its caller's env. */
  sealedBase: Readonly<Record<string, string>> = {},
): SpawnPort {
  const env = (program: string, options?: SpawnOptions): Record<string, string> =>
    options?.sealed === true
      ? // Never the tool overlay, whatever the program is called.
        { ...sealedBase, ...resolveEnv(options.env, opener()) }
      : childEnvironment(program, baseEnv, tools, resolveEnv(options?.env, opener()));
  /**
   * One piped child. `signalCode` is read from the Bun subprocess after `exited` settles: a killed child (Bun's
   * `timeout`, an abort `signal`, `kill`) resolves `exited` with `128 + n` while `signalCode` names the signal, and
   * `run` answers that as `exitCode: null` plus the signal. The handle is the frozen `ChildHandle`, which has no such member.
   */
  const spawnChild = (
    program: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): { readonly handle: ChildHandle; readonly signalCode: () => string | null } => {
    const cwd = options?.cwd;
    // A pin is installed for exactly the one spawn statement, no await inside the bracket, and the child is given
    // `.`: it inherits the held directory and resolves `.` against it, never a name re-resolved after the fact.
    const release = cwd === undefined || typeof cwd === 'string' ? undefined : cwd.install();
    const extra = options?.extraPipes ?? 0;
    if (!Number.isInteger(extra) || extra < 0 || extra > MAX_EXTRA_PIPES)
      throw new RangeError(`extraPipes must be a whole number from 0 to ${String(MAX_EXTRA_PIPES)}`);
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = Bun.spawn([program, ...args], {
        ...(cwd === undefined ? {} : { cwd: typeof cwd === 'string' ? cwd : '.' }),
        env: env(program, options),
        ...(extra === 0
          ? { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
          : { stdio: ['pipe', 'pipe', 'pipe', ...Array.from({ length: extra }, () => 'pipe' as const)] }),
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
    // Reading `stdio` hands the daemon's ends over; Bun made them close-on-exec.
    const pipes = extra === 0 ? [] : (child.stdio as unknown as readonly (number | null)[]).slice(3, 3 + extra);
    let pipesOpen = pipes.length > 0;
    const handle: ChildHandle = {
      pid: child.pid,
      pipes: pipes.filter((fd): fd is number => typeof fd === 'number'),
      closePipes: () => {
        if (!pipesOpen) return;
        pipesOpen = false;
        for (const fd of pipes) if (typeof fd === 'number') closeDescriptor(fd, () => undefined);
      },
      stdout: child.stdout,
      stderr: child.stderr,
      write: chunk => {
        child.stdin.write(chunk);
      },
      kill: signal => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
      exited: child.exited.then(code => code),
    };
    return { handle, signalCode: () => signalName(child.signalCode) };
  };
  const start = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    if (detachedAsked(options)) return startDetached(program, args, options, env);
    return spawnChild(program, args, options).handle;
  };
  return {
    start,
    runBytes: async (program, args, options): Promise<SpawnBytesResult> => {
      if (detachedAsked(options)) throw new Error('A detached child is started with start, never runBytes.');
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
      if (detachedAsked(options)) throw new Error('A detached child is started with start, never run.');
      const { handle: child, signalCode } = spawnChild(program, args, options);
      const [stdout, stderr, exited] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      // A child ended by a signal (a timeout, an abort, a kill) has NO exit code: Bun's `exited` says 128 + n, which a
      // caller would read as the program's own verdict.
      const signal = signalCode();
      return signal === null
        ? { exitCode: exited, signal: null, stdout, stderr }
        : { exitCode: null, signal, stdout, stderr };
    },
  };
}

/** Today's Git runner limits. */
const DEFAULT_STDOUT_LIMIT = 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 64 * 1024;

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
      const given = options as
        | { readonly workerData?: unknown; readonly transferList?: readonly unknown[] }
        | undefined;
      const data = given?.workerData;
      // A compiled binary holds its worker programs embedded beside the entry, not where the plugin's URL points.
      const worker = new Worker(embeddedWorkerUrl(moduleUrl), {
        ...(options?.name === undefined ? {} : { name: options.name }),
        ...(options?.env === undefined ? {} : { env: { ...options.env } }),
        ...(data === undefined ? {} : { workerData: data }),
        ...(given?.transferList === undefined ? {} : { transferList: [...given.transferList] }),
      } as WorkerOptions);
      return {
        post: (message, transfer) => worker.postMessage(message, [...(transfer ?? [])]),
        onMessage: listener => {
          const handler = (event: MessageEvent): void => listener(event.data);
          worker.addEventListener('message', handler);
          return () => worker.removeEventListener('message', handler);
        },
        onExit: listener => {
          let reason: string | undefined;
          let told = false;
          const onError = (event: ErrorEvent): void => {
            reason = event.message || String(event.error ?? 'the worker failed');
          };
          const onClose = (event: Event): void => {
            if (told) return;
            told = true;
            const given = (event as Event & { readonly code?: number }).code ?? 0;
            // an uncaught error is a failure even when the runtime reports the thread's code as 0
            const code = reason !== undefined && given === 0 ? 1 : given;
            listener(reason === undefined ? { code } : { code, reason });
          };
          worker.addEventListener('error', onError);
          worker.addEventListener('close', onClose);
          return () => {
            worker.removeEventListener('error', onError);
            worker.removeEventListener('close', onClose);
          };
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
