import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildHandle, Clock, FencedPath, RootHandle, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';
import { instantFromEpochMs, ok } from '@ferretry/std';
import { CodexAppServerCatalog } from '../../daemon/adapters/app-server-catalog.ts';
import { HeldFastCatalog } from '../../daemon/adapters/held-catalog.ts';

/**
 * The Codex catalog a fast start is judged against is HELD: read by a child that has its OWN created folder and a
 * scrubbed environment with a throwaway HOME, never the daemon user's real HOME (and so never `~/.codex`).
 */

const DAEMON_HOME = '/home/the-daemon-user';
const temps: string[] = [];
afterAll(async () => {
  for (const path of temps) await rm(path, { recursive: true, force: true });
});

const clock: Clock = {
  now: () => instantFromEpochMs(0),
  nowMs: () => 0,
  after: () => () => undefined,
  every: () => () => undefined,
  sleep: async () => undefined,
};

/** A workspace root backed by a real temp folder, so "the folder exists" is a fact about the disk. */
async function workspace(): Promise<{ readonly root: RootHandle; readonly base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'fy-held-catalog-'));
  temps.push(base);
  const root = {
    resolve: (relative: string) => ok(join(base, relative) as FencedPath),
    makeDirectory: async (path: FencedPath) => {
      await mkdir(path, { recursive: true });
    },
  } as unknown as RootHandle;
  return { root, base };
}

interface Started {
  readonly program: string;
  readonly cwd: string | undefined;
  /** Whether the folder was a directory at the instant the child was started. */
  readonly cwdExisted: Promise<boolean>;
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** A spawn port whose child speaks just enough of the app-server handshake, noting where and how it was started. */
function spawnPort(started: Started[]): SpawnPort {
  const encoder = new TextEncoder();
  return {
    run: async () => {
      throw new Error('not used');
    },
    runBytes: async () => {
      throw new Error('not used');
    },
    start: (program: string, _args: readonly string[], options?: SpawnOptions): ChildHandle => {
      const cwd = typeof options?.cwd === 'string' ? options.cwd : undefined;
      // Asked at the instant of the start: a child started in a folder that is not there does not start at all.
      const cwdExisted =
        cwd === undefined
          ? Promise.resolve(false)
          : stat(cwd).then(
              found => found.isDirectory(),
              () => false,
            );
      started.push({ program, cwd, cwdExisted, env: options?.env as Started['env'] });
      let push: (line: string) => void = () => undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          push = line => controller.enqueue(encoder.encode(`${line}\n`));
        },
      });
      const model = {
        model: 'gpt-6-sol',
        displayName: 'GPT-6-Sol',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
        defaultReasoningEffort: 'medium',
      };
      return {
        pid: 1,
        stdout,
        stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
        write: chunk => {
          const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          if (text.includes('"initialize"')) push(JSON.stringify({ id: 1, result: {} }));
          if (text.includes('"model/list"')) push(JSON.stringify({ id: 2, result: { data: [model] } }));
        },
        kill: () => undefined,
        pipes: [],
        closePipes: () => undefined,
        exited: Promise.resolve(0),
      };
    },
  };
}

async function subject(
  started: Started[],
  environment = async (name: 'PATH' | 'LANG') => (name === 'PATH' ? '/usr/bin' : 'C.UTF-8'),
) {
  const { root, base } = await workspace();
  const appServer = new CodexAppServerCatalog({
    spawn: spawnPort(started),
    clock,
    clientName: 'ferretry',
    clientVersion: '0.0.0-test',
  });
  const catalog = new HeldFastCatalog({
    workspace: root,
    environment,
    locate: async () =>
      ({ outcome: 'located', path: '/opt/codex/bin/codex', rule: 'inherited path', declaredBy: 'PATH' }) as never,
    read: async (binary, cwd, env) => await appServer.models(binary, cwd, env),
  });
  return { catalog, base };
}

describe('the held Codex catalog', () => {
  test('(no guarantees row) nothing is held before the first read, and holding never spawns', async () => {
    const started: Started[] = [];
    const { catalog } = await subject(started);
    expect(catalog.held()).toBeUndefined();
    expect(started).toHaveLength(0);
  });

  test("(no guarantees row) the child's cwd exists when it starts, and it is inside the plugin's own folder", async () => {
    const started: Started[] = [];
    const { catalog, base } = await subject(started);
    await catalog.refresh();
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd?.startsWith(base)).toBe(true);
    expect(await started[0]?.cwdExisted).toBe(true);
  });

  test("(no guarantees row) the child's HOME is a throwaway inside the plugin's folder, never the daemon's HOME", async () => {
    const started: Started[] = [];
    const { catalog, base } = await subject(started);
    await catalog.refresh();
    const env = started[0]?.env;
    expect(env).toBeDefined();
    expect(env?.HOME).not.toBe(DAEMON_HOME);
    expect(env?.HOME?.startsWith(base)).toBe(true);
    expect(env?.CODEX_HOME?.startsWith(base)).toBe(true);
    for (const value of Object.values(env ?? {})) expect(value.includes(DAEMON_HOME)).toBe(false);
    // The whole environment is the scrubbed one: nothing of the daemon's own beyond PATH and LANG.
    expect(Object.keys(env ?? {}).sort()).toEqual(
      [
        'ALL_PROXY',
        'CI',
        'CODEX_HOME',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'LANG',
        'NO_PROXY',
        'PATH',
        'TMPDIR',
        'all_proxy',
        'http_proxy',
        'https_proxy',
      ].sort(),
    );
  });

  test('(no guarantees row) a read that works is held, and a later failed read keeps it', async () => {
    const started: Started[] = [];
    const { catalog } = await subject(started);
    await catalog.refresh();
    expect(catalog.held()?.map(choice => choice.value)).toEqual(['gpt-6-sol']);
    // A second refresh whose child cannot be started fails, and the first catalog is still held.
    const failing = new HeldFastCatalog({
      workspace: (await workspace()).root,
      environment: async () => undefined,
      locate: async () => ({ outcome: 'located', path: '/opt/codex/bin/codex' }) as never,
      read: async () => {
        throw new Error('the Codex model catalog probe timed out');
      },
    });
    await expect(failing.refresh()).rejects.toThrow('timed out');
    expect(failing.held()).toBeUndefined();
  });

  test('(no guarantees row) no Codex binary located reads nothing and holds nothing', async () => {
    const started: Started[] = [];
    const { root } = await workspace();
    const catalog = new HeldFastCatalog({
      workspace: root,
      environment: async () => undefined,
      locate: async () => ({ outcome: 'absent' }) as never,
      read: async () => {
        started.push({ program: '', cwd: undefined, cwdExisted: Promise.resolve(false), env: undefined });
        return [];
      },
    });
    await catalog.refresh();
    expect(started).toHaveLength(0);
    expect(catalog.held()).toBeUndefined();
  });
});
