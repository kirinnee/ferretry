/**
 * A daemon of one release, in this process (redesign §10.5): the REAL kernel host booted over the release's generated
 * daemon registry, listening on a real Unix socket and a loopback port, in a temp home.
 *
 * The one seam is `HostOptions.contractHash`, which `fyd` itself fills from its generated registry
 * (`packages/core/kernel/host/fyd.ts`): this file passes the same four things `fyd` passes (`implementations`,
 * `contractHash`, `version`, `listen`) and nothing else a production daemon does not. No environment override, no hook:
 * a daemon that could report hashes it was not built with would weaken the guard this fixture tests.
 *
 * It never touches the network: the `fetch` adapter refuses, and the run is under `scripts/ci/test.sh`'s `FY_*=off`
 * environment besides.
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHost,
  fileLogSink,
  listenLocal,
  realAdapters,
  type RunningHost,
} from '../../../packages/core/kernel/host/index.ts';
import { contractHashOf, type Release } from './releases.ts';

/** The binary name the host's sentences use; the rig never runs one. */
const BINARY = 'fy';

export interface StartedDaemon {
  readonly host: RunningHost;
  /** The loopback listener's origin, from the run record the host wrote. */
  readonly url: string;
  readonly home: string;
  /** The release version this daemon says on `GET /v1/health`. */
  readonly version: string;
  /** Reads the admin token Gate minted, waiting for it. The value is returned to the caller and never printed. */
  adminToken(): Promise<string>;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `read` until it answers, for at most `ms`. */
async function until<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not appear within ${ms} ms`);
    await sleep(25);
  }
}

/**
 * Boots a daemon of `release`, saying `options.version` on `GET /v1/health`. "Older" and "newer" than the app are the
 * version alone: the hashes are the release's own.
 */
export async function startDaemon(release: Release, options: { readonly version: string }): Promise<StartedDaemon> {
  // The home's Unix socket path has a platform length limit, so the folder names stay short.
  const parent = mkdtempSync(join(tmpdir(), 'fyd-'));
  const home = join(parent, 'h');
  const sink = fileLogSink(line => {
    try {
      appendFileSync(join(home, 'logs', 'fyd.log'), line, { mode: 0o600 });
    } catch {
      // the home is not decided yet
    }
  });
  const real = realAdapters(home, sink, { binary: BINARY, childEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  const outcome = await bootHost({
    home,
    version: options.version,
    implementations: release.daemon.daemonImplementations,
    // No network: the same adapters as `fyd`, with `fetch` refusing.
    adapters: {
      ...real,
      fetch: {
        request: () => Promise.reject(new Error('the two-release fixture reaches no network')),
      },
    },
    contractHash: contractHashOf(release.daemon),
    pid: process.pid,
    listen: async host =>
      await listenLocal(host, {
        home,
        port: 0,
        pid: process.pid,
        version: options.version,
        write: (path, text) => writeFile(path, text, { mode: 0o600 }),
        chmod: (path, mode) => chmod(path, mode),
        remove: path => rm(path, { force: true }),
      }),
  });
  if (outcome.kind === 'refused') {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`the ${release.name} daemon refused to boot: ${outcome.sentence}`);
  }
  const { host } = outcome;
  // A host that booted must be stopped when anything after it fails: it holds a Unix socket and a loopback listener in
  // the one process every integration file shares.
  let run: { host: string; port: number };
  try {
    run = await until(
      async () =>
        JSON.parse(await readFile(join(home, 'run', 'daemon.json'), 'utf8')) as { host: string; port: number },
      10_000,
      'the run record',
    );
  } catch (error) {
    await host.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  return {
    host,
    url: `http://${run.host}:${run.port}`,
    home,
    version: options.version,
    adminToken: async () =>
      await until(
        async () => (await readFile(join(home, 'state', 'gate', 'admin-token'), 'utf8')).trim() || undefined,
        15_000,
        'the admin token',
      ),
    stop: async () => {
      await host.stop();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
