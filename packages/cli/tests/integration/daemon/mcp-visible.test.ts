/**
 * MCP SERVERS ARE VISIBLE ON A DAEMON THAT BOOTS OVER AN OWNER-WRITTEN CONFIG, with no further config write (triage row
 * 55; v4 republished the fleet after the first config load and after every change).
 *
 * The REAL daemon registry of this commit, booted over a temp home whose `config/` an owner wrote by hand: one login,
 * one runtime, one profile naming `mcp/acme`, and the `mcp/acme` item. Nothing is written through a route. `GET /v1/mcp`
 * is the route `fy mcp ls` and the Settings MCP screen both read.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';

let registry: DaemonRegistry;
let daemon: StartedDaemon | undefined;

beforeAll(async () => {
  registry = await realDaemonRegistry();
});

afterEach(async () => {
  await daemon?.stop().catch(() => undefined);
  daemon = undefined;
});

const LOGIN = 'harness: claude-code\nstore: ferretry\n';
const RUNTIME = 'login: claude-you\nprofile: default\nagent: true\n';
const PROFILE = 'contents:\n  - mcp/acme\n';
const ACME = 'command: npx\nargs:\n  - acme-mcp\n';

async function write(home: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = join(home, 'config', path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text);
  }
}

const OWNER_CONFIG = {
  'logins/claude-you.yaml': LOGIN,
  'runtimes/claude-default.yaml': RUNTIME,
  'profiles/default.yaml': PROFILE,
  'mcp/acme.yaml': ACME,
} as const;

interface Inventory {
  readonly servers: readonly { readonly name: string; readonly scope: string; readonly runtimes: readonly unknown[] }[];
}

async function inventory(started: StartedDaemon): Promise<Inventory> {
  const token = await started.adminToken();
  const response = await fetch(`${started.url}/v1/mcp`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status !== 200)
    throw new Error(`GET /v1/mcp answered ${String(response.status)}\n${started.diagnose()}`);
  return (await response.json()) as Inventory;
}

const namesOf = (listed: Inventory): readonly string[] => listed.servers.map(server => server.name);

/** The listed server by name; a miss carries the daemon's own account (plugin outcomes, masked log tail). */
function listedServer(started: StartedDaemon, listed: Inventory, name: string): Inventory['servers'][number] {
  const found = listed.servers.find(server => server.name === name);
  if (found === undefined)
    throw new Error(
      `${name} is not in the inventory (${namesOf(listed).join(', ') || 'empty'})\n${started.diagnose()}`,
    );
  return found;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe('MCP servers an owner wrote into config/ are visible with no config write', () => {
  test('on boot: the daemon publishes the runtimes from the files, so the machine inventory lists the server', async () => {
    daemon = await startDaemon({ name: 'A', daemon: registry } as never, {
      version: '5.0.0',
      seed: async home => await write(home, OWNER_CONFIG),
    });

    // The once-after-start publish is a job: it finishes a moment after the listener is up.
    const listed = await until(
      async () => await inventory(daemon as StartedDaemon),
      value => namesOf(value).includes('acme'),
    );

    expect(listedServer(daemon, listed, 'acme').runtimes).toHaveLength(1);
  }, 60_000);

  test('while running: files an owner adds later are published on the change, with no config write through a route', async () => {
    daemon = await startDaemon({ name: 'A', daemon: registry } as never, { version: '5.0.0' });
    expect(namesOf(await inventory(daemon))).not.toContain('acme');

    await write(daemon.home, OWNER_CONFIG);

    const listed = await until(
      async () => await inventory(daemon as StartedDaemon),
      value => namesOf(value).includes('acme'),
    );
    expect(listedServer(daemon, listed, 'acme').name).toBe('acme');
  }, 60_000);
});
