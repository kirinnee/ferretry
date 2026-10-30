/**
 * A REAL `fyd` IN A CHILD PROCESS whose usage-feed step is slow, hiccups or stalls, and the operator's
 * view of it. A child process because the watchdog ends a daemon whose loop has stopped with SIGKILL,
 * and a test runner it shared a process with would go with it. Shared by the integration tier's
 * staged-boot journeys and the realworld tier's liveness-speed claim.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildWorld } from '../../../bin/fyd.ts';
import { freeLoopbackPort } from './booted-daemon.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from './repository.ts';

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

/**
 * The child's whole program. `slow` waits four seconds without blocking, as a boot over a large fleet
 * does; `hiccup` blocks the loop for 1.2 seconds after a moment and carries on; `stall` blocks it for a
 * minute, which the watchdog must end.
 */
const program = (mode: 'slow' | 'hiccup' | 'stall'): string => `
  import { buildWorld, start } from ${modulePath('../../../bin/fyd.ts')};
  import { NO_RELAY_DIRECTORY } from ${modulePath('../../../src/lib/relay/discovery.ts')};
  const mode = ${JSON.stringify(mode)};
  const block = milliseconds => { const until = Date.now() + milliseconds; while (Date.now() < until) {} };
  const world = buildWorld({}, { userHome: ${JSON.stringify(ABSENT_USER_HOME)} });
  process.exit(await start({
    ...world,
    relayDirectory: { read: async () => NO_RELAY_DIRECTORY },
    createUsageFeed: async config => {
      await Bun.sleep(mode === 'slow' ? 4_000 : 1_500);
      if (mode === 'hiccup') block(1_200);
      if (mode === 'stall') block(60_000);
      return await world.createUsageFeed(config);
    },
    untilShutdown: () => new Promise(() => undefined),
  }));
`;

export interface Running {
  readonly child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
  readonly base: string;
  /** Everything the daemon has written to its journal so far. */
  journal(): string;
  /** When the journal's `starting` line arrived, in this process's clock. */
  startedAtMs(): number | undefined;
}

const running: Running[] = [];

/** Kills every daemon `bootStagedDaemon` started and removes the temporary homes. */
export async function stopStagedDaemons(): Promise<void> {
  for (const each of running.splice(0)) {
    each.child.kill('SIGKILL');
    await each.child.exited;
  }
  await cleanupTempDirectories();
}

async function seededHome(port: number): Promise<string> {
  const home = await tempDirectory('fyd-staged-boot-');
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
  await opened.storage.close();
  if (previous === undefined) delete process.env.FY_HOME;
  else process.env.FY_HOME = previous;
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
    { mode: 0o600 },
  );
  return home;
}

export async function bootStagedDaemon(
  mode: 'slow' | 'hiccup' | 'stall',
  environment: Record<string, string> = {},
): Promise<Running> {
  const port = await freeLoopbackPort();
  const home = await seededHome(port);
  const child = Bun.spawn({
    cmd: [process.execPath, '--eval', program(mode)],
    env: { ...process.env, FY_HOME: home, HOME: ABSENT_USER_HOME, ...environment },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let text = '';
  let startedAtMs: number | undefined;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      text += decoder.decode(chunk);
      if (startedAtMs === undefined && / starting — /u.test(text)) startedAtMs = Date.now();
    }
  })();
  const daemon: Running = {
    child,
    base: `http://127.0.0.1:${String(port)}`,
    journal: () => text,
    startedAtMs: () => startedAtMs,
  };
  running.push(daemon);
  return daemon;
}

export interface Answer {
  readonly status: number;
  readonly body: { readonly status?: string; readonly boot?: { readonly step?: string; readonly phase?: string } };
  readonly atMs: number;
}

export async function liveness(base: string): Promise<Answer | undefined> {
  const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
  if (response === undefined) return undefined;
  return { status: response.status, body: (await response.json()) as Answer['body'], atMs: Date.now() };
}

export async function until<T>(
  read: () => Promise<T | undefined>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && done(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
