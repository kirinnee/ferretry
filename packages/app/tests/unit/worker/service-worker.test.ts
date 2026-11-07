import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pluginWorkerFiles, refusePluginWorkers } from '../../../scripts/build-release.ts';
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
  const result = await Bun.build({
    entrypoints: [join(root, 'packages/app/src/worker/service-worker.ts')],
    format: 'iife',
    target: 'browser',
    splitting: false,
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
  return { signed, listeners, order, shown, opened, dispatch, state: () => state };
}

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
  for (const url of ['https://evil.example/', '/d/other/board', '/d/abc/board', undefined]) {
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
    `${APP_ORIGIN}/d/abc`,
    `${APP_ORIGIN}/d/abc`,
    `${APP_ORIGIN}/d/abc/board`,
    `${APP_ORIGIN}/d/abc`,
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
