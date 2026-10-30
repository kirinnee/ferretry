/**
 * A real `fyd` in its own process and state home, for the integration tier: its own identity, vault and
 * configuration, the hosted relay switched off, and the host admin token as its only credential (so the
 * owner at the machine is ungoverned and nothing asks for a passkey).
 *
 * The test plays the browser. Call {@link stopBootedDaemons} from `afterEach`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildWorld } from '../../../bin/fyd.ts';
import { OS_CHOSEN_PORT, recordedPort } from './os-port.ts';
import { ABSENT_USER_HOME, tempDirectory } from './repository.ts';
import { waitFor } from './wait-for.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');

const children: Bun.Subprocess[] = [];

/** Kills every daemon this module started. */
export async function stopBootedDaemons(): Promise<void> {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
}

export interface BootedDaemon {
  readonly home: string;
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}

export interface BootOptions {
  /** Runs once the state home exists and before the daemon starts: seed configuration or credentials here. */
  readonly seed?: (home: string) => Promise<void>;
}

export async function bootDaemon(label: string, options: BootOptions = {}): Promise<BootedDaemon> {
  const home = await tempDirectory(`ferretry-clone-${label}-`);
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
  await opened.storage.close();
  if (previous === undefined) delete process.env.FY_HOME;
  else process.env.FY_HOME = previous;
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({ host: '127.0.0.1', port: OS_CHOSEN_PORT, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
    { mode: 0o600 },
  );
  await options.seed?.(home);
  const child = Bun.spawn({
    cmd: [process.execPath, FYD_ENTRY],
    env: { ...process.env, FY_HOME: home, HOME: ABSENT_USER_HOME },
    stdin: 'ignore',
    stdout: Bun.file(join(home, 'fyd.out')),
    stderr: Bun.file(join(home, 'fyd.err')),
  });
  children.push(child);
  const base = `http://127.0.0.1:${String(await recordedPort(home))}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`the ${label} daemon exited (${child.exitCode}) before it answered`);
    return (await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true;
  }, `the ${label} daemon to answer /healthz`).catch(async (error: Error) => {
    throw new Error(`${error.message}: ${await readFile(join(home, 'fyd.err'), 'utf8')}`, { cause: error });
  });
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    home,
    base,
    headers,
    get: async path => await fetch(`${base}${path}`, { headers }),
    post: async (path, body) =>
      await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}
