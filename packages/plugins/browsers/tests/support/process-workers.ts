import type { ChildHandle, SpawnPort } from '@ferretry/kernel/contract';
import { bunSpawn, globalFetch } from '@ferretry/kernel/host';
import { fileURLToPath } from 'node:url';
import { processHost } from '../../daemon/adapters/host.ts';
import type { StartWorker } from '../../daemon/worker/client.ts';
import type { LoginProcesses } from '../../daemon/worker/control/adapters/login-runtime.ts';
import type { LauncherPorts } from '../../daemon/worker/launcher.ts';
import { NODE_WORKER_FLAGS } from '../../daemon/worker/program.ts';
import { wallClock } from './wall-clock.ts';

/**
 * Worker PROCESSES as the daemon half starts them (`kernel.spawn.start` of the worker program, the host's
 * `bunSpawn`), for the scripted fake worker or the real entry, with what a test needs to watch them: how many
 * started, which have exited, and a way to make one die mid-request the way a crashed worker would.
 */
export interface ProcessWorkers {
  readonly start: StartWorker;
  started(): number;
  /** Whether worker `index` has exited (its process is gone). */
  terminated(index: number): boolean;
  pid(index: number): number;
  crash(index: number, signal?: 'SIGKILL' | 'SIGTERM'): void;
}

/**
 * `entry` runs under `runtime`: the fake `.mjs` under this Bun, the real worker entry under Node (Playwright's CDP
 * WebSocket never completes under Bun, which is why the worker is a process at all).
 */
export function processWorkers(entry: URL, runtime: readonly string[] = [process.execPath]): ProcessWorkers {
  const spawn = bunSpawn({});
  const children: { child: ChildHandle; exited: boolean }[] = [];
  const [program, ...lead] = runtime;
  if (program === undefined) throw new Error('a runtime is required');
  return {
    start: (args, env) => {
      const child = spawn.start(program, [...lead, fileURLToPath(entry), ...args], { env });
      const record = { child, exited: false };
      void child.exited.then(() => {
        record.exited = true;
      });
      children.push(record);
      return child;
    },
    started: () => children.length,
    terminated: index => children[index]?.exited === true,
    pid: index => {
      const record = children[index];
      if (record === undefined) throw new Error(`no worker ${String(index)} was started`);
      return record.child.pid;
    },
    crash: (index, signal = 'SIGKILL') => {
      const record = children[index];
      if (record === undefined) throw new Error(`no worker ${String(index)} was started`);
      record.child.kill(signal);
    },
  };
}

/** The real worker entry under Node, as a source checkout runs it. */
export const REAL_WORKER = (): ProcessWorkers =>
  processWorkers(new URL('../../daemon/worker/adapters/main.ts', import.meta.url), [
    Bun.which('node') ?? 'node',
    ...NODE_WORKER_FLAGS,
  ]);

/**
 * The launcher's ports as the daemon binds them, on real processes and loopback: the host's `bunSpawn` with no base
 * environment (the launcher names every child's environment), `globalFetch`, this host's facts. `misbehave` wraps the
 * Chrome the launcher starts (never its `--version` run) so one of its handles misbehaves.
 */
export function launcherPorts(
  options: {
    readonly clock?: LauncherPorts['clock'];
    readonly misbehave?: () => ((child: ChildHandle) => Partial<ChildHandle>) | undefined;
  } = {},
): LauncherPorts {
  const base = bunSpawn({});
  const spawn: Pick<SpawnPort, 'start' | 'run'> = {
    run: async (program, args, spawnOptions) => await base.run(program, args, spawnOptions),
    start: (program, args, spawnOptions) => {
      const started = base.start(program, args, spawnOptions);
      const wrap = options.misbehave?.();
      return wrap === undefined ? started : { ...started, ...wrap(started) };
    },
  };
  return { clock: options.clock ?? wallClock(), spawn, fetch: globalFetch(), host: processHost() };
}

/**
 * The sign-in window's and the private display's processes (\`LoginProcesses\`) on real children: the host's
 * \`bunSpawn\` over this process's environment (today's Xvfb and \`--version\` runs inherited it), the wall clock, and
 * this host's platform and environment.
 */
export function loginProcesses(): LoginProcesses {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  return { spawn: bunSpawn(environment), clock: wallClock(), platform: process.platform, environment: process.env };
}
