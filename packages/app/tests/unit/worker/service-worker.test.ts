import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pluginWorkerFiles, refusePluginWorkers, workerInputGuard } from '../../../scripts/build-release.ts';
import { buildRelease, releaseSigner } from '../../support/release.ts';

const root = resolve(import.meta.dir, '../../../../..');
const APP_ORIGIN = 'https://app.example';

/** The review's probe variants: each rewrote the realm's globals from a plugin's `app/worker.ts`. */
const PROBES = [
  "const O = Response; Response = function (_b, init) { return new O('UNSIGNED PROBE BYTES', init); }; export default {};",
  "const g = (function () { return this })(); g['Resp'+'onse'] = function () {}; export default {};",
  "export { default } from './helper.ts';",
  "registration.unregister(); skipWaiting(); clients.openWindow('https://evil.example/'); export default {};",
];

type Listener = (event: Record<string, unknown>) => void;

/** The real worker, built the way the release build compiles it, run against fake browser ports. */
async function startWorker(options: { readonly scope?: string; readonly script?: string } = {}) {
  const signer = await releaseSigner();
  const signed = await buildRelease(signer);
  const inputs = new Set<string>();
  const result = await Bun.build({
    entrypoints: [join(root, 'packages/app/src/worker/service-worker.ts')],
    format: 'iife',
    target: 'browser',
    splitting: false,
    plugins: [workerInputGuard(undefined, inputs)],
    define: {
      __FY_RELEASE_KEY__: JSON.stringify(signer.publicKey),
      __FY_RELEASE_REWRITES__: JSON.stringify([{ from: '/app/*', to: '/app/index.html' }]),
      __FY_RELEASE_HEADERS__: JSON.stringify([{ pattern: '/*', detach: [], set: [['X-Signed-Release', 'yes']] }]),
    },
  });
  expect(result.success).toBe(true);
  const listeners = new Map<string, Listener[]>();
  const order: string[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const site = new Map([
    ['release-manifest.json', new TextDecoder().decode(signed.manifestBytes)],
    ['release-manifest.sig', signed.signatureText],
    ...Object.entries(signed.files),
  ]);
  const stored = new Map<string, Map<string, Response>>();
  let state: unknown = null;
  // Only the browser ports are fake. The bundled keeper verifies a real Ed25519 signature and file hashes.
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore: () => ({
          get: () => {
            const request = { result: state, onsuccess: undefined as (() => void) | undefined };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put: (value: unknown) => {
            state = value;
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
      };
      return transaction;
    },
  };
  runInNewContext(await result.outputs[0]!.text(), {
    URL,
    Response,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
    atob,
    btoa,
    location: {
      origin: APP_ORIGIN,
      hostname: 'app.example',
      href: options.script ?? `${APP_ORIGIN}/sw.verified.js`,
    },
    registration: {
      scope: options.scope ?? `${APP_ORIGIN}/`,
      showNotification: async (title: string, notification: Record<string, unknown>) => {
        shown.push({ title, options: notification });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
    indexedDB: {
      open: () => {
        const request = { result: database, onsuccess: undefined as (() => void) | undefined };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
    caches: {
      keys: async () => [...stored.keys()],
      delete: async (key: string) => stored.delete(key),
      open: async (name: string) => {
        const cache = stored.get(name) ?? new Map<string, Response>();
        stored.set(name, cache);
        return {
          put: async (key: string, response: Response) => {
            cache.set(key, response);
          },
          match: async (key: string) => cache.get(key)?.clone(),
        };
      },
    },
    fetch: async (input: string | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const body = url.origin === APP_ORIGIN ? site.get(url.pathname.slice(1)) : 'passed through';
      return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
    },
    addEventListener: (type: string, listener: Listener) => {
      order.push(type);
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  });
  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Promise<unknown>[] = [];
    for (const listener of listeners.get(type) ?? [])
      listener({ stopImmediatePropagation() {}, waitUntil: (p: Promise<unknown>) => pending.push(p), ...event });
    await Promise.all(pending);
  };
  return { signed, listeners, order, shown, opened, dispatch, inputs, state: () => state };
}

test('the guarded release worker has exactly its shell inputs, the kernel contract’s push envelope and zod, with no plugin import graph', async () => {
  const worker = await startWorker();
  const app = realpathSync(join(root, 'packages/app'));
  const zod = realpathSync(resolve(Bun.resolveSync('zod/package.json', app), '..'));
  const shell = [...worker.inputs].filter(path => path.startsWith(`${app}/`));
  expect(shell.map(path => relative(app, path)).sort()).toEqual([
    'src/release/headers.ts',
    'src/release/keeper.ts',
    'src/release/loopback.ts',
    'src/release/manifest.ts',
    'src/release/storage.ts',
    'src/release/verification.ts',
    'src/router/routes.ts',
    'src/router/tap-target.ts',
    'src/storage/names.ts',
    'src/worker/facts.ts',
    'src/worker/notifications.ts',
    'src/worker/push-envelope.ts',
    'src/worker/service-worker.ts',
  ]);
  const envelope = realpathSync(Bun.resolveSync('@ferretry/kernel/contract/push-envelope', app));
  const libraries = [...worker.inputs].filter(path => !shell.includes(path));
  expect(libraries).toContain(envelope);
  expect(libraries.every(path => path === envelope || path.startsWith(`${zod}/`))).toBe(true);
});

test('the release worker guard refuses a transitive non-worker import even without a plugin worker file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fy-worker-graph-'));
  try {
    await mkdir(join(directory, 'src/worker'), { recursive: true });
    await mkdir(join(directory, 'src/layout'), { recursive: true });
    await writeFile(join(directory, 'src/worker/probe.ts'), "import './helper.ts';");
    await writeFile(join(directory, 'src/layout/probe.ts'), 'globalThis.Response = undefined;');
    for (const specifier of ['../layout/probe.ts', 'node:events', 'path', 'bun:jsc']) {
      await writeFile(join(directory, 'src/worker/helper.ts'), `import '${specifier}';`);
      const failure = await Bun.build({
        entrypoints: [join(directory, 'src/worker/probe.ts')],
        target: 'browser',
        plugins: [workerInputGuard(directory)],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(String).join('\n')).toContain(
        'no plugin code may run in the signed service worker',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the worker runs only its own listeners and serves signed bytes; a daemon or POST request gets no answer', async () => {
  const worker = await startWorker();
  // Every listener is the worker's own, registered once each, the release check's first.
  expect(worker.order).toEqual(['install', 'activate', 'fetch', 'message', 'push', 'notificationclick']);
  await worker.dispatch('install', {});
  expect(worker.state()).not.toBeNull();
  for (const [request, expected] of [
    [new Request(`${APP_ORIGIN}/app/`), worker.signed.files['app/index.html']!],
    [new Request('https://daemon.example/request'), undefined],
    [new Request('https://relay.example/v1/rendezvous/x/client'), undefined],
    [new Request(`${APP_ORIGIN}/app/`, { method: 'POST', body: 'x' }), undefined],
  ] as const) {
    let stopped = false;
    let answer: Promise<Response> | undefined;
    worker.listeners.get('fetch')![0]!({
      request,
      stopImmediatePropagation: () => {
        stopped = true;
      },
      waitUntil: () => undefined,
      respondWith: (response: Promise<Response>) => {
        expect(answer).toBeUndefined();
        answer = response;
      },
    });
    // Every fetch stops later listeners first, whether or not the worker answers it.
    expect(stopped).toBe(true);
    if (expected === undefined) {
      // Today's pass-through: no answer at all, so the browser sends the request itself, untouched.
      expect(answer).toBeUndefined();
      continue;
    }
    const response = await answer!;
    expect(await response.text()).toBe(expected);
    expect(response.headers.get('X-Signed-Release')).toBe('yes');
  }
});

test('a push is shown plainly, titled for the machine whose registration received it', async () => {
  const appWide = await startWorker();
  await appWide.dispatch('push', { data: { json: () => ({ title: 'Anything a daemon said' }) } });
  expect(appWide.shown).toEqual([
    {
      title: 'Unverified · Ferretry',
      options: {
        icon: '/icons/icon-any-192.png',
        badge: '/icons/badge-96.png',
        body: 'Something is waiting in your Agenda.',
      },
    },
  ]);

  const machine = await startWorker({
    scope: `${APP_ORIGIN}/push/abc/`,
    script: `${APP_ORIGIN}/sw.verified.js?machine=Work%20laptop`,
  });
  await machine.dispatch('push', { data: null });
  expect(machine.shown.map(notification => notification.title)).toEqual(['Work laptop · Ferretry']);
});

test('a notification tap opens only this site, and only the machine’s own pages', async () => {
  const machine = await startWorker({ scope: `${APP_ORIGIN}/push/abc/` });
  for (const url of [
    'https://evil.example/',
    `${APP_ORIGIN}/d/other/ferrets/f1/chat?ask=A3`,
    `${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`,
    undefined,
  ]) {
    let closed = false;
    await machine.dispatch('notificationclick', {
      notification: {
        data: { url },
        close: () => {
          closed = true;
        },
      },
    });
    expect(closed).toBe(true);
  }
  expect(machine.opened).toEqual([
    `${APP_ORIGIN}/app/`,
    `${APP_ORIGIN}/app/`,
    `${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`,
    `${APP_ORIGIN}/app/`,
  ]);
});

test('the release build refuses any plugin app/worker.ts, so no probe variant can reach the worker', async () => {
  // This repository ships none.
  expect(await pluginWorkerFiles(root)).toEqual([]);
  await expect(refusePluginWorkers(root)).resolves.toBeUndefined();

  const directory = await mkdtemp(join(tmpdir(), 'fy-worker-probe-'));
  try {
    for (const [index, probe] of PROBES.entries()) {
      const group = index % 2 === 0 ? 'packages/plugins' : 'packages/core';
      const app = join(directory, group, `probe${index}`, 'app');
      await mkdir(app, { recursive: true });
      await writeFile(join(app, 'worker.ts'), probe);
      await writeFile(join(app, 'helper.ts'), PROBES[0]!);
      await expect(refusePluginWorkers(directory)).rejects.toThrow(
        `no plugin code may run in the signed service worker; remove ${group}/probe${index}/app/worker.ts`,
      );
      await rm(join(directory, group), { recursive: true, force: true });
    }
    await mkdir(join(directory, 'packages/plugins/clean/app'), { recursive: true });
    await writeFile(join(directory, 'packages/plugins/clean/app/index.ts'), 'export default {};');
    await expect(refusePluginWorkers(directory)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const SENT = {
  version: 1,
  eventKey: 'e1',
  title: 'Deploy approval',
  body: 'Ship the build?',
  tag: 'agenda-A3',
  url: '/ferrets/f1/chat?ask=A3',
  count: 1,
};

test('a machine’s push carries the page it named, and its tap opens exactly that chat at the ask', async () => {
  const machine = await startWorker({
    scope: `${APP_ORIGIN}/push/abc/`,
    script: `${APP_ORIGIN}/sw.verified.js?machine=Beta`,
  });
  await machine.dispatch('push', { data: { json: () => SENT } });
  expect(machine.shown).toEqual([
    {
      title: 'Beta · Deploy approval',
      options: {
        icon: '/icons/icon-any-192.png',
        badge: '/icons/badge-96.png',
        body: 'Ship the build?',
        data: { url: `${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3` },
      },
    },
  ]);
  await machine.dispatch('notificationclick', {
    notification: { data: machine.shown[0]!.options.data, close: () => {} },
  });
  expect(machine.opened).toEqual([`${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`]);
});

test('the app-wide registration’s push always opens /app/, whatever page it named', async () => {
  const appWide = await startWorker();
  for (const url of [
    '/ferrets/f1/chat?ask=A3',
    '/d/laptop/settings/access',
    '/ferrets/../../../d/other/ferrets/x/chat',
  ]) {
    await appWide.dispatch('push', { data: { json: () => ({ ...SENT, url }) } });
  }
  expect(appWide.shown.map(notification => notification.options.data)).toEqual([
    { url: `${APP_ORIGIN}/app/` },
    { url: `${APP_ORIGIN}/app/` },
    { url: `${APP_ORIGIN}/app/` },
  ]);
  expect(appWide.shown.map(notification => notification.title)).toEqual(Array(3).fill('Unverified · Deploy approval'));
});

test('S2 a line the page itself showed under the app-wide registration opens its chat; a hostile stored address opens /app/', async () => {
  const appWide = await startWorker();
  const tap = async (url: unknown): Promise<void> =>
    appWide.dispatch('notificationclick', { notification: { data: { url }, close: () => {} } });
  // The page watcher’s “needs input” line for a machine’s ferret: absolute, or relative to the site.
  await tap(`${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`);
  await tap('/d/abc/ferrets/f1/chat?ask=A3');
  // Whatever else is stored: not this site, not a machine’s closed list, not an address at all.
  for (const hostile of [
    'https://evil.test/d/abc/ferrets/f1/chat',
    '//evil.test/d/abc',
    'javascript:alert(1)',
    `${APP_ORIGIN}/d/abc/ferrets/../../d/other`,
    `${APP_ORIGIN}/ferrets/f1/chat`,
    7,
  ])
    await tap(hostile);
  expect(appWide.opened).toEqual([
    `${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`,
    `${APP_ORIGIN}/d/abc/ferrets/f1/chat?ask=A3`,
    ...Array(6).fill(`${APP_ORIGIN}/app/`),
  ]);
});

test('a push whose payload is not readable JSON, or has no envelope, is shown plainly with no page', async () => {
  const machine = await startWorker({ scope: `${APP_ORIGIN}/push/abc/` });
  await machine.dispatch('push', {
    data: {
      json: () => {
        throw new Error('not json');
      },
    },
  });
  await machine.dispatch('push', { data: { json: () => ({ kind: 'clear', tags: ['x'] }) } });
  expect(machine.shown.map(notification => notification.title)).toEqual(['abc · Ferretry', 'abc · Ferretry']);
  expect(machine.shown.every(notification => !('data' in notification.options))).toBe(true);
});
