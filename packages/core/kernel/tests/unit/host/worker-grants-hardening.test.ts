import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FetchPort, WorkerHandle, WorkersPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { PluginLifecycle } from '../../../host/lifecycle.ts';
import { hostPermitted, restrictFetch, workersFor } from '../../../host/permissions.ts';
import { rootsPortFor } from '../../../host/roots.ts';
import {
  GRANT_REFUSAL_WINDOW_MS,
  MAX_GRANT_BODY_BYTES,
  MAX_GRANT_IN_FLIGHT,
  MAX_GRANT_REFUSALS_PER_WINDOW,
  WORKER_GRANTS_KEY,
} from '../../../host/worker-grants/wire.ts';

/**
 * The grant channel with no real thread: the "worker" is the test itself, holding the far end of the very channel
 * the kernel made, so what it posts is what a forged or flooding worker could post.
 */
const FAKE_SECRET = 'fake-token-value-0002';
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface Reply {
  id: number;
  ok: boolean;
  refusal?: string;
  value?: unknown;
}

async function harness(options: { hang?: boolean } = {}) {
  const parent = await mkdtemp(`${tmpdir()}/worker-grants-hardening-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const store = `${home}/state/logins/credentials`;
  await mkdir(store, { recursive: true, mode: 0o700 });
  await writeFile(`${store}/a.json`, JSON.stringify({ token: FAKE_SECRET }));
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'logins', worktrees: `${home}-worktrees` },
    ['credentials'],
    () => undefined,
  );
  const declared = ['api.example.com'];
  const seen: Array<{ url: string; headers: unknown; bytes: number; signal: AbortSignal | undefined }> = [];
  const base: FetchPort = {
    request: (url, init) => {
      const body = init?.body;
      seen.push({
        url: String(url),
        headers: init?.headers,
        bytes: typeof body === 'string' ? body.length : ((body as Uint8Array | undefined)?.byteLength ?? 0),
        signal: init?.signal ?? undefined,
      });
      if (options.hang !== true) return Promise.resolve(new Response('fake-body'));
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    },
  };
  let data: Record<string, { port: MessagePort }> = {};
  let terminated = 0;
  const exits: Array<(exit: never) => void> = [];
  const fake: WorkersPort = {
    start: (_url, given) => {
      data = (given as unknown as { workerData: typeof data }).workerData;
      const handle: WorkerHandle = {
        post: () => undefined,
        onMessage: () => () => undefined,
        onExit: listener => {
          exits.push(listener as (exit: never) => void);
          return () => undefined;
        },
        terminate: async () => {
          terminated += 1;
        },
      };
      return handle;
    },
  };
  let now = 0;
  const flooded: string[] = [];
  const lifecycle = new PluginLifecycle();
  const workers = workersFor(
    fake,
    () => undefined,
    {
      plugin: 'logins',
      roots,
      fetch: restrictFetch('logins', declared, base),
      declaresNetwork: true,
      mayReach: (hostname, host) =>
        hostPermitted(declared, () => ({ programs: [], hosts: [] }), hostname, undefined, host),
      nowMs: () => now,
      flooded: plugin => flooded.push(plugin),
    },
    { onStop: fn => lifecycle.onStop(fn), stopping: () => lifecycle.stopping() },
  );
  const replies: Reply[] = [];
  const start = (grants: { network?: true | string[] } = { network: true }) => {
    const handle = workers.start(new URL('file:///not-a-real-worker.ts'), { roots: ['credentials'], ...grants });
    const port = data[WORKER_GRANTS_KEY]?.port as MessagePort;
    port.onmessage = event => replies.push(event.data as Reply);
    return { handle, port };
  };
  const settle = async (): Promise<void> => {
    await new Promise<void>(resolve => setTimeout(resolve, 40));
  };
  return {
    store,
    seen,
    replies,
    flooded,
    lifecycle,
    workers,
    start,
    settle,
    advance: (ms: number) => {
      now += ms;
    },
    terminated: () => terminated,
    exit: () => {
      for (const listener of exits) listener({} as never);
    },
  };
}

const read = (id: number, path: unknown) => ({ kind: 'root', id, root: 'credentials', op: 'readText', args: [path] });
const fetchOf = (id: number, init?: unknown) => ({ kind: 'fetch', id, url: 'https://api.example.com/x', init });

describe('worker grants hardening: the channel carries paths relative to the root, bodies under the cap', () => {
  test('S41 an absolute path is refused even when it falls inside the root, and a relative one is served', async () => {
    const h = await harness();
    const { port } = h.start();
    port.postMessage(read(1, `${h.store}/a.json`));
    port.postMessage(read(2, 'a.json'));
    port.postMessage(read(3, '\\a.json'));
    port.postMessage(read(4, 'a\0.json'));
    await h.settle();
    const byId = (id: number) => h.replies.find(reply => reply.id === id);
    expect(byId(1)).toMatchObject({ ok: false, refusal: 'outside' });
    expect(byId(2)).toMatchObject({ ok: true });
    expect(byId(3)).toMatchObject({ ok: false, refusal: 'outside' });
    expect(byId(4)).toMatchObject({ ok: false, refusal: 'outside' });
    expect(JSON.stringify(h.replies)).not.toContain(h.store);
  });

  test('a request body past the cap (16 MiB, text or bytes) is refused too_large and never reaches the network', async () => {
    const h = await harness();
    const { port } = h.start();
    port.postMessage(fetchOf(1, { method: 'POST', body: 'x'.repeat(2 * MAX_GRANT_BODY_BYTES) }));
    port.postMessage(fetchOf(2, { method: 'POST', body: new Uint8Array(2 * MAX_GRANT_BODY_BYTES) }));
    port.postMessage(fetchOf(3, { method: 'POST', body: 'x'.repeat(1024) }));
    await h.settle();
    expect(h.replies.find(reply => reply.id === 1)).toMatchObject({ ok: false, refusal: 'too_large' });
    expect(h.replies.find(reply => reply.id === 2)).toMatchObject({ ok: false, refusal: 'too_large' });
    expect(h.replies.find(reply => reply.id === 3)).toMatchObject({ ok: true });
    expect(h.seen.map(call => call.bytes)).toEqual([1024]);
  });

  test('a worker-set Host header is refused, in any case; other headers pass', async () => {
    const h = await harness();
    const { port } = h.start();
    port.postMessage(fetchOf(1, { headers: [['Host', 'evil.example']] }));
    port.postMessage(fetchOf(2, { headers: [['hOsT', 'evil.example']] }));
    port.postMessage(fetchOf(3, { headers: [['accept', 'text/plain']] }));
    await h.settle();
    expect(h.replies.find(reply => reply.id === 1)).toMatchObject({ ok: false, refusal: 'malformed' });
    expect(h.replies.find(reply => reply.id === 2)).toMatchObject({ ok: false, refusal: 'malformed' });
    expect(h.replies.find(reply => reply.id === 3)).toMatchObject({ ok: true });
    expect(h.seen).toHaveLength(1);
  });

  test('a host grant without a port is the default port only', async () => {
    const h = await harness();
    const { port } = h.start({ network: ['api.example.com'] });
    port.postMessage({ kind: 'fetch', id: 1, url: 'https://api.example.com:8443/x' });
    port.postMessage({ kind: 'fetch', id: 2, url: 'https://api.example.com/x' });
    await h.settle();
    expect(h.replies.find(reply => reply.id === 1)).toMatchObject({ ok: false, refusal: 'not_granted' });
    expect(h.replies.find(reply => reply.id === 2)).toMatchObject({ ok: true });
  });
});

describe('worker grants hardening: a flood ends the channel', () => {
  test('more refusals than the bound in one window close the channel; nothing is answered after', async () => {
    const h = await harness();
    const { port } = h.start();
    for (let i = 0; i < MAX_GRANT_REFUSALS_PER_WINDOW + 5; i += 1) port.postMessage({ id: i, kind: 'nonsense' });
    await h.settle();
    expect(h.flooded).toEqual(['logins']);
    const answered = h.replies.length;
    expect(answered).toBeLessThanOrEqual(MAX_GRANT_REFUSALS_PER_WINDOW + 1);
    port.postMessage(fetchOf(99));
    await h.settle();
    expect(h.replies).toHaveLength(answered);
    expect(h.seen).toEqual([]);
  });

  test('refusals spread over separate windows do not end the channel', async () => {
    const h = await harness();
    const { port } = h.start();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < MAX_GRANT_REFUSALS_PER_WINDOW - 10; i += 1) port.postMessage({ id: i, kind: 'nonsense' });
      await h.settle();
      h.advance(GRANT_REFUSAL_WINDOW_MS);
    }
    port.postMessage(fetchOf(5000));
    await h.settle();
    expect(h.flooded).toEqual([]);
    expect(h.replies.find(reply => reply.id === 5000)).toMatchObject({ ok: true });
  });
});

describe('worker grants hardening: the channel lives and dies with the thread and the plugin', () => {
  test('terminate closes the channel: a request after it gets no reply and reaches nothing', async () => {
    const h = await harness();
    const { handle, port } = h.start();
    port.postMessage(fetchOf(1));
    await h.settle();
    expect(h.replies).toHaveLength(1);
    await handle.terminate();
    port.postMessage(fetchOf(2));
    port.postMessage(read(3, 'a.json'));
    await h.settle();
    expect(h.replies).toHaveLength(1);
    expect(h.seen).toHaveLength(1);
  });

  test('a worker that exits on its own closes the channel too', async () => {
    const h = await harness();
    const { port } = h.start();
    h.exit();
    port.postMessage(fetchOf(1));
    port.postMessage(read(2, 'a.json'));
    await h.settle();
    expect(h.replies).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  test('a plugin that fails or stops loses its grants: the channel closes, the thread ends, and a new grant start refuses', async () => {
    const h = await harness();
    const { port } = h.start();
    port.postMessage(fetchOf(1));
    await h.settle();
    expect(h.replies).toHaveLength(1);
    await h.lifecycle.stop(() => undefined);
    expect(h.terminated()).toBe(1);
    port.postMessage(fetchOf(2));
    port.postMessage(read(3, 'a.json'));
    await h.settle();
    expect(h.replies).toHaveLength(1);
    expect(h.seen).toHaveLength(1);
    expect(() => h.start()).toThrow('has stopped');
  });
});

describe('worker grants hardening: in-flight cap and cancel', () => {
  test('the request past the in-flight cap, and a duplicate id, are refused busy', async () => {
    const h = await harness({ hang: true });
    const { port } = h.start();
    for (let i = 0; i < MAX_GRANT_IN_FLIGHT; i += 1) port.postMessage(fetchOf(i));
    port.postMessage(fetchOf(MAX_GRANT_IN_FLIGHT));
    port.postMessage(fetchOf(0));
    await h.settle();
    expect(h.seen).toHaveLength(MAX_GRANT_IN_FLIGHT);
    expect(h.replies.map(reply => [reply.id, reply.refusal])).toEqual([
      [MAX_GRANT_IN_FLIGHT, 'busy'],
      [0, 'busy'],
    ]);
  });

  test('cancel aborts the main-side request, and the slot is free again', async () => {
    const h = await harness({ hang: true });
    const { port } = h.start();
    port.postMessage(fetchOf(1));
    await h.settle();
    expect(h.seen[0]?.signal?.aborted).toBe(false);
    port.postMessage({ kind: 'cancel', id: 1 });
    await h.settle();
    expect(h.seen[0]?.signal?.aborted).toBe(true);
    expect(h.replies.find(reply => reply.id === 1)).toMatchObject({ ok: false, refusal: 'failed' });
    port.postMessage(fetchOf(1));
    await h.settle();
    expect(h.seen).toHaveLength(2);
  });
});
