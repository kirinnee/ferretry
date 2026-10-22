/**
 * Proves the store a model holds when it shares its runtime with other models, and Whisper's shape of
 * it: one Install downloads the runtime then the model as one progress stream, a runtime another model
 * installed is never downloaded again, the status is the model's (a runtime on its own is not a
 * half-installed model), Remove keeps a runtime something else still needs, and the worker's read is
 * every model file keyed by the pinned URL transformers.js asks for.
 *
 * Cache Storage is a `Map` and the network a fake `fetch` over byte-exact miniatures; nothing touches
 * the network or a real model.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import type { WhisperCatalogModel } from '../../../src/lib/stt/model-catalog.ts';
import {
  type ModelCacheLike,
  type ModelCacheStorage,
  ModelInstallError,
  type ModelInstallProgress,
  type PinnedBundle,
  type PinnedFile,
} from '../../../src/lib/stt/model-store.ts';
import { RuntimeModelStore } from '../../../src/lib/stt/runtime-model-store.ts';
import { WHISPER_RUNTIME_FILE, WHISPER_TINY_EN_CATALOG_MODEL } from '../../../src/lib/stt/whisper-model.ts';
import { WhisperModelStore } from '../../../src/lib/stt/whisper-store.ts';

const NOW = new Date('2026-10-22T08:00:00.000Z');
const PART = 64;

const bytesOf = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + 7) % 251);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A pinned file over a miniature, and the bytes the fake network serves for it. */
const pinned = (role: string, url: string, bytes: Uint8Array): { file: PinnedFile; bytes: Uint8Array } => ({
  bytes,
  file: { role, label: role, url, bytes: bytes.length, sha256: sha256Of(bytes) },
});

class MemoryCache implements ModelCacheLike {
  readonly entries = new Map<string, Uint8Array>();

  async put(key: string, response: Response): Promise<void> {
    this.entries.set(key, new Uint8Array(await response.arrayBuffer()));
  }

  async match(key: string): Promise<Response | undefined> {
    const hit = this.entries.get(key);
    return hit === undefined ? undefined : new Response(hit.slice());
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}

class MemoryCaches implements ModelCacheStorage {
  readonly caches = new Map<string, MemoryCache>();
  readonly deleted: string[] = [];

  async open(name: string): Promise<ModelCacheLike> {
    const existing = this.caches.get(name);
    if (existing !== undefined) return existing;
    const created = new MemoryCache();
    this.caches.set(name, created);
    return created;
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
}

/** Serves miniatures by URL and remembers every request. */
const network = (served: ReadonlyMap<string, Uint8Array>) => {
  const asked: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    asked.push(url);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = served.get(url);
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body.slice());
  };
  return { fetch, asked };
};

const RUNTIME = pinned('runtime', '/assets/runtime.wasm', bytesOf(150, 1));
const MODEL_A = [pinned('encoder', 'https://models.test/a/encoder', bytesOf(100, 2))];
const MODEL_B = [pinned('encoder', 'https://models.test/b/encoder', bytesOf(70, 3))];

const bundle = (name: string, files: readonly { file: PinnedFile }[]): PinnedBundle => ({
  name,
  cache: `fy-stt-${name}-v1`,
  keyRoot: `/fy-stt/${name}`,
  versionLabel: `${name} · 1`,
  files: files.map(entry => entry.file),
});

const RUNTIME_BUNDLE = bundle('runtime', [RUNTIME]);
const SERVED = new Map([RUNTIME, ...MODEL_A, ...MODEL_B].map(entry => [entry.file.url, entry.bytes]));

const store = (
  caches: MemoryCaches,
  fetch: ReturnType<typeof network>['fetch'],
  model: PinnedBundle,
  runtimeInUse: () => boolean = () => false,
): RuntimeModelStore =>
  new RuntimeModelStore({
    runtime: RUNTIME_BUNDLE,
    model,
    caches,
    fetch,
    storage: null,
    now: () => NOW,
    partBytes: PART,
    runtimeInUse,
  });

describe('RuntimeModelStore', () => {
  it('counts the runtime and the model in what an empty device downloads', () => {
    const caches = new MemoryCaches();
    should(store(caches, network(SERVED).fetch, bundle('a', MODEL_A)).totalBytes).equal(250);
  });

  it('installs the runtime first, then the model, as one progress stream that ends at the total', async () => {
    const caches = new MemoryCaches();
    const { fetch, asked } = network(SERVED);
    const a = store(caches, fetch, bundle('a', MODEL_A));
    const seen: ModelInstallProgress[] = [];
    await a.install({ onProgress: progress => seen.push(progress) });
    should(asked).eql(['/assets/runtime.wasm', 'https://models.test/a/encoder']);
    should(seen.every(progress => progress.totalBytes === 250)).be.true();
    const downloaded = seen.map(progress => progress.downloadedBytes);
    should(downloaded).eql([...downloaded].sort((x, y) => x - y));
    should(downloaded.at(-1)).equal(250);
    should(seen.some(progress => progress.label === 'runtime')).be.true();
    should(seen.at(-1)?.label).equal('encoder');
    should(await a.status()).eql({ state: 'installed', version: 'a · 1', bytes: 250, installedAt: NOW.toISOString() });
  });

  it('installs without anyone listening, and never downloads a runtime another model installed', async () => {
    const caches = new MemoryCaches();
    const { fetch, asked } = network(SERVED);
    await store(caches, fetch, bundle('a', MODEL_A)).install();
    const b = store(caches, fetch, bundle('b', MODEL_B));
    should(await b.status()).eql({ state: 'absent' });
    await b.install();
    should(asked).eql(['/assets/runtime.wasm', 'https://models.test/a/encoder', 'https://models.test/b/encoder']);
    should((await b.status()).state).equal('installed');
  });

  it('is partial while either half has bytes still to come', async () => {
    const caches = new MemoryCaches();
    const { fetch } = network(SERVED);
    const a = store(caches, fetch, bundle('a', MODEL_A));
    await a.install();
    // The runtime was removed under it (another model's Remove that thought nothing needed it).
    await caches.delete(RUNTIME_BUNDLE.cache);
    should(await a.status()).eql({ state: 'partial', downloadedBytes: 100 });

    const half = new MemoryCaches();
    const cut = network(new Map([...SERVED, [MODEL_A[0]?.file.url ?? '', bytesOf(100, 2).slice(0, PART)]]));
    const partial = store(half, cut.fetch, bundle('a', MODEL_A));
    await partial.install().catch(() => undefined);
    should(await partial.status()).eql({ state: 'partial', downloadedBytes: 150 + PART });
  });

  it('passes a cancel through, keeping what is finished', async () => {
    const caches = new MemoryCaches();
    const { fetch } = network(SERVED);
    const a = store(caches, fetch, bundle('a', MODEL_A));
    const controller = new AbortController();
    controller.abort();
    const failure = await a.install({ signal: controller.signal }).catch((error: unknown) => error);
    should(failure).be.instanceOf(ModelInstallError);
    should((failure as ModelInstallError).code).equal('cancelled');
  });

  it('removes the runtime with the model only when nothing else installed runs on it', async () => {
    const caches = new MemoryCaches();
    const { fetch } = network(SERVED);
    let inUse = true;
    const a = store(caches, fetch, bundle('a', MODEL_A), () => inUse);
    await a.install();
    await a.remove();
    should(caches.deleted).eql(['fy-stt-a-v1']);
    await a.install();
    inUse = false;
    await a.remove();
    should(caches.deleted).eql(['fy-stt-a-v1', 'fy-stt-a-v1', 'fy-stt-runtime-v1']);
    should(await a.status()).eql({ state: 'absent' });
  });

  it('reads both bundles back, verified, by role', async () => {
    const caches = new MemoryCaches();
    const a = store(caches, network(SERVED).fetch, bundle('a', MODEL_A));
    await a.install();
    const bytes = await a.read();
    should([...(bytes.runtime.get('runtime') ?? [])]).eql([...RUNTIME.bytes]);
    should([...(bytes.model.get('encoder') ?? [])]).eql([...(MODEL_A[0]?.bytes ?? [])]);
  });
});

describe('WhisperModelStore', () => {
  /** A Whisper entry whose files are miniatures, at the real entry's roles and URLs. */
  const files = WHISPER_TINY_EN_CATALOG_MODEL.files.map((file, index) =>
    pinned(file.role, file.url, bytesOf(10 + index, 10 + index)),
  );
  const model: WhisperCatalogModel = { ...WHISPER_TINY_EN_CATALOG_MODEL, files: files.map(entry => entry.file) };
  const runtimeBytes = bytesOf(40, 9);
  const runtimeFile = { ...WHISPER_RUNTIME_FILE, bytes: 40, sha256: sha256Of(runtimeBytes) };
  const served = new Map<string, Uint8Array>([
    ['/assets/runtime-x.wasm', runtimeBytes],
    ...files.map(entry => [entry.file.url, entry.bytes] as const),
  ]);
  const whisper = (
    caches: MemoryCaches,
    fetch: ReturnType<typeof network>['fetch'],
    runtimeUrl = '/assets/runtime-x.wasm',
  ) =>
    new WhisperModelStore({
      model,
      runtimeUrl,
      caches,
      fetch,
      partBytes: PART,
      runtimeFile,
      runtimeInUse: () => false,
    });

  it('stores the shared runtime under the transformers.js bundle, and each model under its own cache', async () => {
    const caches = new MemoryCaches();
    const { fetch, asked } = network(served);
    await whisper(caches, fetch).install();
    should(asked).eql(['/assets/runtime-x.wasm', ...model.files.map(file => file.url)]);
    should([...caches.caches.keys()].sort()).eql(['fy-stt-transformers-js-v1', 'fy-stt-whisper-tiny-en-v1']);
  });

  it('hands the worker the runtime and every model file by the pinned URL transformers.js asks for', async () => {
    const caches = new MemoryCaches();
    const { fetch } = network(served);
    await whisper(caches, fetch).install();
    // The worker reads with no runtime URL and a fetch that refuses: reading never downloads.
    const read = await whisper(caches, async () => Promise.reject(new Error('no network')), '').readModel();
    should([...read.runtime]).eql([...runtimeBytes]);
    should([...read.files.keys()]).eql(model.files.map(file => file.url));
    for (const entry of files) should([...(read.files.get(entry.file.url) ?? [])]).eql([...entry.bytes]);
  });

  it('pins the real runtime binary when no miniature is given', () => {
    const real = new WhisperModelStore({
      model: WHISPER_TINY_EN_CATALOG_MODEL,
      runtimeUrl: '/assets/r.wasm',
      caches: null,
      fetch: network(served).fetch,
      runtimeInUse: () => false,
    });
    should(real.totalBytes).equal(
      WHISPER_RUNTIME_FILE.bytes + WHISPER_TINY_EN_CATALOG_MODEL.files.reduce((total, file) => total + file.bytes, 0),
    );
  });
});
