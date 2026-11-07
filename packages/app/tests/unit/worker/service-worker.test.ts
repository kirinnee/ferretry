import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { validateWorkerExtensions } from '../../../scripts/build-release.ts';
import { bannedIn } from '../../../../../scripts/validate/banned-globals.ts';
import { buildRelease, releaseSigner } from '../../support/release.ts';

const root = resolve(import.meta.dir, '../../../../..');
const PROBE = `
  globalThis.addEventListener('fetch', event => {
    event.stopImmediatePropagation();
    event.respondWith(Promise.resolve(new Response('UNSIGNED PROBE BYTES')));
  });
  export const workerExtensions = [];
`;

test('release listeners precede imported extension initializers and the probe gets only signed bytes', async () => {
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
    plugins: [
      {
        name: 'probe',
        setup(build) {
          build.onLoad({ filter: /src\/worker\/extension-list\.ts$/u }, () => ({
            loader: 'ts',
            contents: "import 'fy-probe-worker'; export const workerExtensions = [];",
          }));
          build.onResolve({ filter: /^fy-probe-worker$/u }, () => ({ path: 'fy-probe-worker', namespace: 'probe' }));
          build.onLoad({ filter: /.*/u, namespace: 'probe' }, () => ({ loader: 'ts', contents: PROBE }));
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  type Listener = (event: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener[]>();
  const order: string[] = [];
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
    location: { origin: 'https://app.example', hostname: 'app.example', href: 'https://app.example/sw.verified.js' },
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
      const body = url.origin === 'https://app.example' ? site.get(url.pathname.slice(1)) : 'passed through';
      return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
    },
    addEventListener: (type: string, listener: Listener) => {
      order.push(type);
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  });
  // Drain the bundled dynamic import: the hostile initializer really ran, after release listeners registered.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(order.slice(0, 4)).toEqual(['install', 'activate', 'fetch', 'message']);
  expect(listeners.get('fetch')).toHaveLength(2);
  const pending: Promise<unknown>[] = [];
  listeners.get('install')![0]!({ stopImmediatePropagation() {}, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
  expect(state).not.toBeNull();
  for (const [url, expected] of [
    ['https://app.example/app/', signed.files['app/index.html']!],
    ['https://daemon.example/request', 'passed through'],
  ] as const) {
    let stopped = false;
    let answer: Promise<Response> | undefined;
    let invoked = 0;
    for (const listener of listeners.get('fetch') ?? []) {
      if (stopped) break;
      invoked++;
      listener({
        request: new Request(url),
        stopImmediatePropagation: () => {
          stopped = true;
        },
        respondWith: (response: Promise<Response>) => {
          expect(answer).toBeUndefined();
          answer = response;
        },
      });
    }
    expect(invoked).toBe(1);
    const response = await answer!;
    expect(await response.text()).toBe(expected);
    if (url.startsWith('https://app.example')) expect(response.headers.get('X-Signed-Release')).toBe('yes');
  }
});

test('worker validation refuses the probe and capability access hidden in imported initializers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fy-worker-probe-'));
  try {
    const app = join(directory, 'app');
    await Bun.write(join(app, 'worker.ts'), PROBE);
    expect(
      bannedIn(join(app, 'worker.ts'))
        .map(f => f.message)
        .join('\n'),
    ).toContain('globalThis');
    await expect(validateWorkerExtensions([join(app, 'worker.ts')])).rejects.toThrow(
      'worker extension capabilities refused',
    );
    await writeFile(join(app, 'worker.ts'), "import './helper.ts'; export default { id: 'probe' };");
    await writeFile(join(app, 'helper.ts'), PROBE);
    await expect(validateWorkerExtensions([join(app, 'worker.ts')])).rejects.toThrow(
      'worker extension capabilities refused',
    );
    await writeFile(join(app, 'helper.ts'), 'export const label = "safe";');
    await expect(validateWorkerExtensions([join(app, 'worker.ts')])).resolves.toBeUndefined();
    await writeFile(
      join(app, 'worker.ts'),
      "import { defineWorkerExtension } from '@ferretry/app/worker'; export default defineWorkerExtension({ id: 'probe' });",
    );
    await expect(validateWorkerExtensions([join(app, 'worker.ts')])).resolves.toBeUndefined();
    await writeFile(
      join(app, 'worker.ts'),
      "import 'https://example.invalid/code.js'; export default { id: 'probe' };",
    );
    await expect(validateWorkerExtensions([join(app, 'worker.ts')])).rejects.toThrow(
      'worker extension capabilities refused',
    );
    for (const name of [
      'addEventListener',
      'respondWith',
      'caches',
      'indexedDB',
      'importScripts',
      'self',
      'globalThis',
      'fetch',
    ]) {
      await writeFile(join(app, 'worker.ts'), `const leaked = ${name}; export default leaked;`);
      expect(bannedIn(join(app, 'worker.ts')).some(f => f.message.includes(`uses ${name}:`))).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
