/**
 * Proves the Parakeet model store: a resumable, part-based, SHA-256-verified download into Cache Storage.
 *
 * Everything is a fake. Cache Storage is a `Map`, the network is a fake `fetch` that can honour or ignore a
 * `Range`, stream in odd chunk sizes, die mid-stream, refuse, hang until aborted, send a body that is too long
 * or the wrong bytes, and the model is four byte-exact miniatures (hashed here with `node:crypto`) cut into
 * 64-byte parts. Nothing touches the network or the real model.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import {
  formatMegabytes,
  PARAKEET_TOTAL_BYTES,
  type ParakeetFile,
  type ParakeetFileRole,
} from '../../../src/lib/stt/parakeet-model.ts';
import {
  PARAKEET_DOWNLOAD_SIZE,
  PARAKEET_PART_BYTES,
  type ParakeetCacheLike,
  type ParakeetCacheStorage,
  type ParakeetFetch,
  ParakeetInstallError,
  type ParakeetInstallProgress,
  ParakeetModelStore,
  type ParakeetModelStoreOptions,
  type ParakeetStorageManager,
} from '../../../src/lib/stt/parakeet-store.ts';
import { Sha256 } from '../../../src/lib/stt/sha256.ts';

const CACHE_NAME = 'fy-stt-parakeet-v1';
const ROOT = '/fy-stt/parakeet';
const PART = 64;
const NOW = new Date('2026-10-16T08:30:00.000Z');

const partKey = (role: ParakeetFileRole, index: number): string =>
  `${ROOT}/${role}/part-${String(index).padStart(4, '0')}`;
const completeKey = (role: ParakeetFileRole): string => `${ROOT}/${role}/complete`;
const progressKey = (role: ParakeetFileRole): string => `${ROOT}/${role}/progress`;
const INSTALLED_KEY = `${ROOT}/installed`;

const bytesOf = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + 7) % 251);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface Mini {
  readonly file: ParakeetFile;
  readonly bytes: Uint8Array;
}

const mini = (role: ParakeetFileRole, label: string, bytes: Uint8Array): Mini => ({
  bytes,
  file: { role, label, url: `https://models.test/${role}`, bytes: bytes.length, sha256: sha256Of(bytes) },
});

// Encoder: 3 parts (64 + 64 + 22). Decoder: exactly one part. Vocabulary: smaller than a part. Runtime: 4 parts.
const ENCODER = mini('encoder', 'Encoder', bytesOf(150, 1));
const DECODER = mini('decoder', 'Decoder', bytesOf(64, 2));
const VOCABULARY = mini('vocabulary', 'Vocabulary', new TextEncoder().encode('<unk>\nhello\nworld\n'));
const RUNTIME = mini('runtime', 'Speech runtime', bytesOf(200, 3));
const MINIS: readonly Mini[] = [ENCODER, DECODER, VOCABULARY, RUNTIME];
const FILES: readonly ParakeetFile[] = MINIS.map(entry => entry.file);
const TOTAL = FILES.reduce((sum, file) => sum + file.bytes, 0);

const quotaError = (): Error =>
  Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
const abortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** An in-memory cache that stores bytes (a Response body is read once) and can refuse a write on demand. */
class MemoryCache implements ParakeetCacheLike {
  readonly entries = new Map<string, Uint8Array>();
  putError: ((key: string) => unknown) | null = null;
  matchFails = false;

  async put(key: string, response: Response): Promise<void> {
    const error = this.putError?.(key);
    if (error !== undefined) throw error;
    this.entries.set(key, new Uint8Array(await response.arrayBuffer()));
  }

  async match(key: string): Promise<Response | undefined> {
    if (this.matchFails) throw new Error('match failed');
    const hit = this.entries.get(key);
    return hit === undefined ? undefined : new Response(hit.slice());
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  seed(key: string, value: unknown): void {
    this.entries.set(key, new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));
  }

  keys(role?: ParakeetFileRole): string[] {
    return [...this.entries.keys()].filter(key => role === undefined || key.startsWith(`${ROOT}/${role}/`));
  }
}

class MemoryCaches implements ParakeetCacheStorage {
  readonly caches = new Map<string, MemoryCache>();
  readonly deleted: string[] = [];
  openError: unknown = undefined;

  cache(name = CACHE_NAME): MemoryCache {
    const existing = this.caches.get(name);
    if (existing !== undefined) return existing;
    const created = new MemoryCache();
    this.caches.set(name, created);
    return created;
  }

  async open(name: string): Promise<ParakeetCacheLike> {
    if (this.openError !== undefined) throw this.openError;
    return this.cache(name);
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
}

interface Plan {
  readonly status?: number;
  readonly rejectWith?: { readonly error: unknown };
  readonly hang?: boolean;
  readonly ignoreRange?: boolean;
  readonly nullBody?: boolean;
  readonly chunk?: number;
  /** Error the stream after this many body bytes. */
  readonly failAfter?: number;
  /** Close the stream cleanly after this many body bytes. */
  readonly endAfter?: number;
  /** Bytes sent beyond what was asked for. */
  readonly extra?: number;
  /** Flip the first body byte. */
  readonly corrupt?: boolean;
}

interface RecordedRequest {
  readonly url: string;
  readonly range: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A fake file host: one queue of per-request behaviours per URL, over a default that applies to every request. */
const makeServer = (served: readonly Mini[]) => {
  const requests: RecordedRequest[] = [];
  const queues = new Map<string, Plan[]>();
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  let base: Plan = {};

  const bodyOf = (bytes: Uint8Array, plan: Plan, signal: AbortSignal | undefined): ReadableStream<Uint8Array> => {
    const limit = plan.failAfter ?? plan.endAfter ?? bytes.length;
    const chunk = plan.chunk ?? Math.max(1, bytes.length);
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(abortError());
          return;
        }
        if (sent >= limit) {
          if (plan.failAfter !== undefined) controller.error(new Error('connection reset'));
          else controller.close();
          return;
        }
        const end = Math.min(sent + chunk, limit);
        controller.enqueue(bytes.slice(sent, end));
        sent = end;
      },
    });
  };

  const fetch: ParakeetFetch = (input, init) => {
    const signal = init?.signal ?? undefined;
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    requests.push({ url: input, range, signal });
    for (const waiter of [...waiters]) {
      if (requests.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    const entry = served.find(candidate => candidate.file.url === input);
    if (entry === undefined) return Promise.reject(new Error(`unexpected URL ${input}`));
    const plan = { ...base, ...(queues.get(input)?.shift() ?? {}) };
    if (signal?.aborted) return Promise.reject(abortError());
    if (plan.rejectWith !== undefined) return Promise.reject(plan.rejectWith.error);
    if (plan.hang === true)
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(abortError())));
    if (plan.status !== undefined) return Promise.resolve(new Response('nope', { status: plan.status }));
    if (plan.nullBody === true) return Promise.resolve(new Response(null, { status: 200 }));
    const ranged = range !== undefined && plan.ignoreRange !== true;
    const start = ranged ? Number(/bytes=(\d+)-/u.exec(range)?.[1]) : 0;
    const tail = entry.bytes.slice(start);
    if (plan.corrupt === true) tail[0] = (tail[0] as number) ^ 0xff;
    const body = plan.extra === undefined ? tail : new Uint8Array([...tail, ...new Uint8Array(plan.extra).fill(0xee)]);
    return Promise.resolve(new Response(bodyOf(body, plan, signal), { status: ranged ? 206 : 200 }));
  };

  return {
    fetch,
    requests,
    setDefault(plan: Plan): void {
      base = plan;
    },
    plan(target: Mini, ...plans: Plan[]): void {
      queues.set(target.file.url, [...(queues.get(target.file.url) ?? []), ...plans]);
    },
    whenRequested(count: number): Promise<void> {
      return requests.length >= count
        ? Promise.resolve()
        : new Promise<void>(resolve => waiters.push({ count, resolve }));
    },
  };
};

const makeStorage = (parts: {
  readonly estimate?: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  readonly persist?: () => Promise<boolean>;
}) => {
  const calls = { estimate: 0, persist: 0 };
  const storage: ParakeetStorageManager = {
    estimate: () => {
      calls.estimate += 1;
      return parts.estimate?.() ?? Promise.resolve({});
    },
    ...(parts.persist === undefined
      ? {}
      : {
          persist: () => {
            calls.persist += 1;
            return (parts.persist as () => Promise<boolean>)();
          },
        }),
  };
  return { storage, calls };
};

const makeStore = (over: Partial<ParakeetModelStoreOptions> = {}) => {
  const caches = new MemoryCaches();
  const server = makeServer(MINIS);
  const store = new ParakeetModelStore({
    caches,
    fetch: server.fetch,
    runtimeUrl: RUNTIME.file.url,
    files: FILES,
    partBytes: PART,
    now: () => NOW,
    ...over,
  });
  return { store, caches, cache: caches.cache(), server };
};

const failure = async (promise: Promise<unknown>): Promise<ParakeetInstallError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  should(caught).be.instanceOf(ParakeetInstallError);
  return caught as ParakeetInstallError;
};

const sameBytes = (actual: Uint8Array, expected: Uint8Array): void => {
  should(hexOf(actual)).equal(hexOf(expected));
};

describe('constants and sizes', () => {
  it('cuts parts at a multiple of the 64-byte hash block and names the whole download', () => {
    should(PARAKEET_PART_BYTES).equal(32 * 1024 * 1024);
    should(PARAKEET_PART_BYTES % 64).equal(0);
    should(PARAKEET_DOWNLOAD_SIZE).equal(formatMegabytes(PARAKEET_TOTAL_BYTES));
    should(PARAKEET_DOWNLOAD_SIZE).match(/^\d+ MB$/u);
  });

  it('totals the files it was given, and the pinned files when it was given none', () => {
    should(makeStore().store.totalBytes).equal(TOTAL);
    const pinned = new ParakeetModelStore({
      caches: null,
      fetch: makeServer([]).fetch,
      runtimeUrl: 'https://app.test/assets/ort.wasm',
    });
    should(pinned.totalBytes).equal(PARAKEET_TOTAL_BYTES);
  });

  it('defaults to 32 MiB parts, so a miniature file is one part', async () => {
    const { store, cache } = makeStore({ partBytes: undefined });
    await store.install();
    should(cache.keys('encoder').filter(key => key.includes('/part-'))).deepEqual([partKey('encoder', 0)]);
    should((await store.read()).vocabulary).equal('<unk>\nhello\nworld\n');
  });
});

describe('ParakeetModelStore.status', () => {
  it('is absent on an empty device', async () => {
    should(await makeStore().store.status()).deepEqual({ state: 'absent' });
  });

  it('is absent where there is no Cache Storage, or where opening it fails', async () => {
    should(await makeStore({ caches: null }).store.status()).deepEqual({ state: 'absent' });
    const { store, caches } = makeStore();
    caches.openError = new Error('denied');
    should(await store.status()).deepEqual({ state: 'absent' });
  });

  it('reads a cache that throws on match as absent', async () => {
    const { store, cache } = makeStore();
    await store.install();
    cache.matchFails = true;
    should(await store.status()).deepEqual({ state: 'absent' });
  });

  it('is installed, with the version, the byte total and the install instant, after a full install', async () => {
    const { store } = makeStore();
    await store.install();
    const status = await store.status();
    should(status.state).equal('installed');
    if (status.state !== 'installed') return;
    should(status.bytes).equal(TOTAL);
    should(status.version).match(/^Parakeet TDT 0\.6B v3 int8 · [0-9a-f]{7}$/u);
    should(status.installedAt).equal('2026-10-16T08:30:00.000Z');
  });

  it('is partial, counting finished files in full, when a later file failed', async () => {
    const { store, server } = makeStore();
    server.plan(VOCABULARY, { status: 503 });
    await failure(store.install());
    should(await store.status()).deepEqual({
      state: 'partial',
      downloadedBytes: ENCODER.file.bytes + DECODER.file.bytes,
    });
  });

  it('counts the hashed bytes of a valid progress record as downloaded', async () => {
    const { store, cache } = makeStore();
    cache.seed(progressKey('encoder'), {
      sha256: ENCODER.file.sha256,
      parts: 1,
      hash: new Sha256().update(ENCODER.bytes.slice(0, PART)).state(),
    });
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: PART });
  });

  it('is partial rather than installed when every file is complete but the install record is missing or has no instant', async () => {
    const { store, cache } = makeStore();
    await store.install();
    cache.entries.delete(INSTALLED_KEY);
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: TOTAL });
    cache.seed(INSTALLED_KEY, {});
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: TOTAL });
  });

  it('ignores a record that is not a JSON object', async () => {
    const { store, cache } = makeStore();
    await store.install();
    for (const garbage of ['not json {', '42', 'null', '"text"']) {
      cache.seed(INSTALLED_KEY, garbage);
      should((await store.status()).state).equal('partial');
    }
  });

  it('does not count a complete record that names a different pinned hash', async () => {
    const { store, cache } = makeStore();
    cache.seed(completeKey('encoder'), { sha256: 'f'.repeat(64) });
    should(await store.status()).deepEqual({ state: 'absent' });
  });

  it('ignores a progress record it cannot trust: other hash, bad state, inconsistent parts, too long', async () => {
    const { store, cache } = makeStore();
    const state = new Sha256().update(ENCODER.bytes.slice(0, PART)).state();
    const untrusted: Record<string, unknown>[] = [
      { sha256: 'a'.repeat(64), parts: 1, hash: state },
      { sha256: ENCODER.file.sha256, parts: 1, hash: { h: [1, 2, 3], length: PART, pending: '' } },
      { sha256: ENCODER.file.sha256, parts: 1, hash: 'a string' },
      { sha256: ENCODER.file.sha256, parts: 5, hash: state },
      { sha256: ENCODER.file.sha256, parts: 4, hash: new Sha256().update(new Uint8Array(PART * 4)).state() },
    ];
    for (const record of untrusted) {
      cache.seed(progressKey('encoder'), record);
      should(await store.status()).deepEqual({ state: 'absent' });
    }
  });
});

describe('ParakeetModelStore.install', () => {
  it('downloads every file in order, stores them in parts, and reports monotonic progress to the total', async () => {
    const { store, server, cache } = makeStore();
    server.setDefault({ chunk: 37 });
    const progress: ParakeetInstallProgress[] = [];
    await store.install({ onProgress: entry => progress.push(entry) });

    should(server.requests.map(request => request.url)).deepEqual(FILES.map(file => file.url));
    should(server.requests.every(request => request.range === undefined && request.signal === undefined)).be.true();

    should(progress[0]).deepEqual({ label: 'Encoder', downloadedBytes: 0, totalBytes: TOTAL });
    should(progress.every(entry => entry.totalBytes === TOTAL)).be.true();
    for (let index = 1; index < progress.length; index += 1)
      should((progress[index] as ParakeetInstallProgress).downloadedBytes).aboveOrEqual(
        (progress[index - 1] as ParakeetInstallProgress).downloadedBytes,
      );
    should((progress.at(-1) as ParakeetInstallProgress).downloadedBytes).equal(TOTAL);
    should([...new Set(progress.map(entry => entry.label))]).deepEqual([
      'Encoder',
      'Decoder',
      'Vocabulary',
      'Speech runtime',
    ]);

    should((cache.entries.get(partKey('encoder', 0)) as Uint8Array).length).equal(64);
    should((cache.entries.get(partKey('encoder', 1)) as Uint8Array).length).equal(64);
    should((cache.entries.get(partKey('encoder', 2)) as Uint8Array).length).equal(22);
    should(cache.entries.has(partKey('encoder', 3))).be.false();
    should(cache.keys('decoder').filter(key => key.includes('/part-'))).deepEqual([partKey('decoder', 0)]);
    for (const { file } of MINIS) {
      should(cache.entries.has(completeKey(file.role))).be.true();
      should(cache.entries.has(progressKey(file.role))).be.true();
    }
    should(JSON.parse(new TextDecoder().decode(cache.entries.get(completeKey('encoder'))))).deepEqual({
      sha256: ENCODER.file.sha256,
    });
    should(await store.status()).have.property('state', 'installed');
  });

  it('stamps the install with the real clock when none is injected', async () => {
    const { store } = makeStore({ now: undefined });
    const before = Date.now();
    await store.install();
    const status = await store.status();
    should(status.state).equal('installed');
    if (status.state !== 'installed') return;
    should(Date.parse(status.installedAt)).aboveOrEqual(before);
    should(Date.parse(status.installedAt)).belowOrEqual(Date.now());
  });

  it('passes the abort signal to every request, and no Range on a fresh download', async () => {
    const { store, server } = makeStore();
    const controller = new AbortController();
    await store.install({ signal: controller.signal });
    should(server.requests.every(request => request.signal === controller.signal)).be.true();
    should(server.requests.every(request => request.range === undefined)).be.true();
  });

  it('skips files that are already complete and reports them as downloaded', async () => {
    const { store, server } = makeStore();
    await store.install();
    server.requests.length = 0;
    const progress: ParakeetInstallProgress[] = [];
    await store.install({ onProgress: entry => progress.push(entry) });
    should(server.requests).have.length(0);
    should(progress.map(entry => entry.downloadedBytes)).deepEqual([
      ENCODER.file.bytes,
      ENCODER.file.bytes + DECODER.file.bytes,
      ENCODER.file.bytes + DECODER.file.bytes + VOCABULARY.file.bytes,
      TOTAL,
    ]);
    should(await store.status()).have.property('state', 'installed');
  });

  it('refuses up front, naming both sizes, when the browser reports too little room', async () => {
    const files = [
      { ...ENCODER.file, bytes: 3_000_000 },
      { ...DECODER.file, bytes: 2_000_000 },
    ];
    const { storage, calls } = makeStorage({
      estimate: async () => ({ quota: 3_000_000, usage: 1_000_000 }),
      persist: async () => true,
    });
    const { store, server } = makeStore({ files, storage });
    const error = await failure(store.install());
    should(error.code).equal('quota');
    should(error.name).equal('ModelInstallError');
    should(error.message).equal(
      'This browser can store about 2 MB more here, and Parakeet needs 5 MB. Free some space on this device, then try again.',
    );
    should(server.requests).have.length(0);
    should(calls.persist).equal(0);
  });

  it('never reports negative room when usage exceeds quota', async () => {
    const { storage } = makeStorage({ estimate: async () => ({ quota: 1_000_000, usage: 2_000_000 }) });
    const { store } = makeStore({ files: [{ ...ENCODER.file, bytes: 4_000_000 }], storage });
    const error = await failure(store.install());
    should(error.message).containEql('about 0 MB more');
    should(error.message).containEql('needs 4 MB');
  });

  it('counts only what is still missing against the room, and asks the browser to keep it', async () => {
    const { storage, calls } = makeStorage({
      estimate: async () => ({ quota: 1_000_000 + VOCABULARY.file.bytes + RUNTIME.file.bytes, usage: 1_000_000 }),
      persist: async () => true,
    });
    const first = makeStore();
    first.server.plan(VOCABULARY, { status: 503 });
    await failure(first.store.install());
    const server = makeServer(MINIS);
    const store = new ParakeetModelStore({
      caches: first.caches,
      fetch: server.fetch,
      runtimeUrl: RUNTIME.file.url,
      files: FILES,
      partBytes: PART,
      storage,
    });
    // Exactly enough room for the vocabulary and the runtime: the two complete files are not counted again.
    await store.install();
    should(server.requests.map(request => request.url)).deepEqual([VOCABULARY.file.url, RUNTIME.file.url]);
    should(calls.estimate).equal(1);
    should(calls.persist).equal(1);
  });

  it('carries on when the storage estimate rejects, is incomplete, or the browser has no storage manager', async () => {
    const estimates = [
      makeStorage({ estimate: () => Promise.reject(new Error('no estimate')) }).storage,
      makeStorage({ estimate: async () => ({ usage: 10 }) }).storage,
      makeStorage({ estimate: async () => ({ quota: 10 }) }).storage,
      makeStorage({ estimate: async () => ({}) }).storage,
      null,
      undefined,
    ];
    for (const storage of estimates) {
      const { store } = makeStore({ storage });
      await store.install();
      should(await store.status()).have.property('state', 'installed');
    }
  });

  it('carries on when the browser refuses or cannot persist', async () => {
    const refusing = makeStorage({ persist: async () => false });
    await makeStore({ storage: refusing.storage }).store.install();
    should(refusing.calls.persist).equal(1);
    const throwing = makeStorage({ persist: () => Promise.reject(new Error('blocked')) });
    const { store } = makeStore({ storage: throwing.storage });
    await store.install();
    should(throwing.calls.persist).equal(1);
    should(await store.status()).have.property('state', 'installed');
  });

  it('throws no-storage without Cache Storage', async () => {
    const error = await failure(makeStore({ caches: null }).store.install());
    should(error.code).equal('no-storage');
    should(error.message).equal('This browser cannot keep the speech model on this device.');
  });
});

describe('ParakeetModelStore.install: resume', () => {
  it('resumes from the first byte it does not have after a mid-stream failure, and verifies the result', async () => {
    const first = makeStore();
    first.server.setDefault({ chunk: 30 });
    first.server.plan(ENCODER, { failAfter: 100 });
    const broken = await failure(first.store.install());
    should(broken.code).equal('network');
    should(broken.message).containEql('Encoder stopped downloading');
    should((broken.cause as Error).message).equal('connection reset');
    should(await first.store.status()).deepEqual({ state: 'partial', downloadedBytes: PART });
    should(first.cache.entries.has(partKey('encoder', 0))).be.true();
    should(first.cache.entries.has(partKey('encoder', 1))).be.false();

    // A brand-new store over the same Cache Storage: the resume point lives on the device, not in memory.
    const server = makeServer(MINIS);
    server.setDefault({ chunk: 30 });
    const second = new ParakeetModelStore({
      caches: first.caches,
      fetch: server.fetch,
      runtimeUrl: RUNTIME.file.url,
      files: FILES,
      partBytes: PART,
      now: () => NOW,
    });
    const progress: ParakeetInstallProgress[] = [];
    await second.install({ onProgress: entry => progress.push(entry) });

    should(first.server.requests.map(request => request.range)).deepEqual([undefined]);
    should(server.requests.map(request => request.range)).deepEqual(['bytes=64-', undefined, undefined, undefined]);
    should(progress[0]).deepEqual({ label: 'Encoder', downloadedBytes: PART, totalBytes: TOTAL });
    should(await second.status()).have.property('state', 'installed');
    const model = await second.read();
    sameBytes(model.encoder, ENCODER.bytes);
    sameBytes(model.decoder, DECODER.bytes);
    sameBytes(model.runtime, RUNTIME.bytes);
  });

  it('keeps finished parts when the server closes the stream early, and resumes after them', async () => {
    const { store, server, cache } = makeStore();
    server.setDefault({ chunk: 30 });
    server.plan(RUNTIME, { endAfter: 100 });
    const error = await failure(store.install());
    should(error.code).equal('network');
    should(error.message).containEql('Speech runtime stopped at');
    should(error.message).containEql('Resume to carry on');
    should(cache.entries.has(partKey('runtime', 0))).be.true();
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: TOTAL - RUNTIME.file.bytes + PART });
    server.requests.length = 0;
    await store.install();
    should(server.requests.map(request => request.range)).deepEqual(['bytes=64-']);
    sameBytes((await store.read()).runtime, RUNTIME.bytes);
  });

  it('restarts the file from zero when the server ignores the Range and sends it whole', async () => {
    const { store, server } = makeStore();
    server.setDefault({ chunk: 30 });
    server.plan(ENCODER, { failAfter: 100 }, { ignoreRange: true });
    await failure(store.install());
    const progress: ParakeetInstallProgress[] = [];
    await store.install({ onProgress: entry => progress.push(entry) });
    should(server.requests.slice(0, 2).map(request => request.range)).deepEqual([undefined, 'bytes=64-']);
    should(progress[0]).deepEqual({ label: 'Encoder', downloadedBytes: 0, totalBytes: TOTAL });
    should(await store.status()).have.property('state', 'installed');
    sameBytes((await store.read()).encoder, ENCODER.bytes);
  });

  it('starts over, with no Range, when the saved progress is untrustworthy', async () => {
    const { store, server, cache } = makeStore();
    cache.seed(progressKey('encoder'), { sha256: 'b'.repeat(64), parts: 1, hash: new Sha256().state() });
    await store.install();
    should(server.requests[0]?.range).be.undefined();
    sameBytes((await store.read()).encoder, ENCODER.bytes);
  });

  it('deletes the whole file when the tail it resumed with is wrong', async () => {
    const { store, server, cache } = makeStore();
    server.setDefault({ chunk: 30 });
    server.plan(ENCODER, { failAfter: 100 }, { corrupt: true });
    await failure(store.install());
    const error = await failure(store.install());
    should(error.code).equal('integrity');
    should(error.message).containEql('did not match the pinned SHA-256');
    should(cache.keys('encoder')).deepEqual([]);
    server.requests.length = 0;
    await store.install();
    should(server.requests[0]?.range).be.undefined();
    sameBytes((await store.read()).encoder, ENCODER.bytes);
  });
});

describe('ParakeetModelStore.install: cancelling', () => {
  it('cancels before anything starts without fetching', async () => {
    const { store, server } = makeStore();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(store.install({ signal: controller.signal }));
    should(error.code).equal('cancelled');
    should(error.message).equal('The download was cancelled.');
    should(server.requests).have.length(0);
  });

  it('cancels while the request is in flight', async () => {
    const { store, server } = makeStore();
    server.plan(ENCODER, { hang: true });
    const controller = new AbortController();
    const outcome = failure(store.install({ signal: controller.signal }));
    await server.whenRequested(1);
    controller.abort();
    should((await outcome).code).equal('cancelled');
    should(server.requests).have.length(1);
  });

  it('cancels while the body is streaming, keeps the finished parts, and a later install resumes', async () => {
    const { store, server, cache } = makeStore();
    server.setDefault({ chunk: 30 });
    const controller = new AbortController();
    const error = await failure(
      store.install({
        signal: controller.signal,
        onProgress: entry => {
          if (entry.downloadedBytes >= 90) controller.abort();
        },
      }),
    );
    should(error.code).equal('cancelled');
    should(cache.entries.has(partKey('encoder', 0))).be.true();
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: PART });

    server.requests.length = 0;
    await store.install();
    should(server.requests[0]?.range).equal('bytes=64-');
    should(await store.status()).have.property('state', 'installed');
    sameBytes((await store.read()).encoder, ENCODER.bytes);
  });

  it('cancels between files and keeps the finished one', async () => {
    const { store, server } = makeStore();
    const controller = new AbortController();
    const error = await failure(
      store.install({
        signal: controller.signal,
        onProgress: entry => {
          if (entry.label === 'Encoder' && entry.downloadedBytes === ENCODER.file.bytes) controller.abort();
        },
      }),
    );
    should(error.code).equal('cancelled');
    should(server.requests).have.length(1);
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: ENCODER.file.bytes });
    await store.install();
    should(server.requests.map(request => request.url)).deepEqual([
      ENCODER.file.url,
      DECODER.file.url,
      VOCABULARY.file.url,
      RUNTIME.file.url,
    ]);
  });

  it('treats an AbortError as a cancellation even when no signal was passed', async () => {
    const { store, server } = makeStore();
    server.plan(ENCODER, { rejectWith: { error: abortError() } });
    should((await failure(store.install())).code).equal('cancelled');
  });
});

describe('ParakeetModelStore.install: failures', () => {
  it('turns an HTTP error into a network error naming the status, and stores nothing', async () => {
    const { store, server, cache } = makeStore();
    server.plan(ENCODER, { status: 503 });
    const error = await failure(store.install());
    should(error.code).equal('network');
    should(error.message).equal('Encoder could not be downloaded (HTTP 503).');
    should(cache.keys('encoder')).deepEqual([]);
  });

  it('turns a rejected fetch into a network error that keeps the cause', async () => {
    const { store, server } = makeStore();
    const offline = new TypeError('Failed to fetch');
    server.plan(ENCODER, { rejectWith: { error: offline } }, { rejectWith: { error: null } });
    const first = await failure(store.install());
    should(first.code).equal('network');
    should(first.message).containEql('Check this device’s connection');
    should(first.cause).equal(offline);
    const second = await failure(store.install());
    should(second.code).equal('network');
    should(second.cause).equal(null);
  });

  it('refuses a response that has no body', async () => {
    const { store, server } = makeStore();
    server.plan(ENCODER, { nullBody: true });
    const error = await failure(store.install());
    should(error.code).equal('network');
    should(error.message).equal('Encoder arrived without a body.');
  });

  it('maps QuotaExceededError on a part to quota, keeps the finished parts, and resumes once there is room', async () => {
    const { store, server, cache } = makeStore();
    cache.putError = key => (key === partKey('encoder', 1) ? quotaError() : undefined);
    const error = await failure(store.install());
    should(error.code).equal('quota');
    should(error.message).equal('This device ran out of room for the speech model. Free some space, then resume.');
    should((error.cause as Error).name).equal('QuotaExceededError');
    should(await store.status()).deepEqual({ state: 'partial', downloadedBytes: PART });

    cache.putError = null;
    server.requests.length = 0;
    await store.install();
    should(server.requests[0]?.range).equal('bytes=64-');
    sameBytes((await store.read()).encoder, ENCODER.bytes);
  });

  it('maps QuotaExceededError on the completion record to quota', async () => {
    const { store, cache } = makeStore();
    cache.putError = key => (key === completeKey('decoder') ? quotaError() : undefined);
    should((await failure(store.install())).code).equal('quota');
  });

  it('maps QuotaExceededError on the install record to quota, and finishes without downloading again', async () => {
    const { store, server, cache } = makeStore();
    cache.putError = key => (key === INSTALLED_KEY ? quotaError() : undefined);
    should((await failure(store.install())).code).equal('quota');

    cache.putError = null;
    server.requests.length = 0;
    await store.install();
    should(server.requests).deepEqual([]);
    should((await store.status()).state).equal('installed');
  });

  it('verifies a file whose every byte was stored but never marked complete, without a Range past its end', async () => {
    const { store, server, cache } = makeStore();
    cache.putError = key => (key === completeKey('decoder') ? quotaError() : undefined);
    should((await failure(store.install())).code).equal('quota');

    cache.putError = null;
    server.requests.length = 0;
    await store.install();
    // The decoder was all there: nothing is asked of the server for it.
    should(server.requests.map(request => request.url)).not.containEql(DECODER.file.url);
    sameBytes((await store.read()).decoder, DECODER.bytes);
  });

  it('maps any other write error to a network error that keeps the cause', async () => {
    const { store, cache } = makeStore();
    const diskFull = new Error('disk is on fire');
    cache.putError = key => (key === partKey('encoder', 0) ? diskFull : undefined);
    const error = await failure(store.install());
    should(error.code).equal('network');
    should(error.cause).equal(diskFull);
  });

  it('refuses a body longer than the pinned size and deletes every stored byte of that file', async () => {
    const { store, server, cache } = makeStore();
    server.plan(ENCODER, { extra: 10, chunk: 70 });
    const error = await failure(store.install());
    should(error.code).equal('integrity');
    should(error.message).equal('Encoder is larger than the pinned file. Nothing was kept.');
    should(cache.keys('encoder')).deepEqual([]);

    // Exactly one part long, so the last part is flushed in the same breath as the oversize bytes arrive.
    server.plan(DECODER, { extra: 5 });
    await failure(store.install());
    should(cache.keys('decoder')).deepEqual([]);
    should(cache.keys('encoder').includes(completeKey('encoder'))).be.true();
  });

  it('refuses the wrong bytes, deletes the file, and installs cleanly on the next try', async () => {
    const { store, server, cache } = makeStore();
    server.plan(ENCODER, { corrupt: true });
    const error = await failure(store.install());
    should(error.code).equal('integrity');
    should(error.message).equal('Encoder did not match the pinned SHA-256, so it was deleted. Try again.');
    should(cache.keys('encoder')).deepEqual([]);
    should(await store.status()).deepEqual({ state: 'absent' });

    server.requests.length = 0;
    await store.install();
    should(server.requests[0]?.range).be.undefined();
    should(await store.status()).have.property('state', 'installed');
  });
});

describe('ParakeetModelStore.remove', () => {
  it('deletes the whole cache, finished or not', async () => {
    const { store, caches, server } = makeStore();
    await store.install();
    await store.remove();
    should(caches.deleted).deepEqual([CACHE_NAME]);
    should(caches.caches.has(CACHE_NAME)).be.false();
    should(await store.status()).deepEqual({ state: 'absent' });

    server.plan(VOCABULARY, { status: 503 });
    await failure(store.install());
    await store.remove();
    should(await store.status()).deepEqual({ state: 'absent' });
  });

  it('does nothing where there is no Cache Storage', async () => {
    await makeStore({ caches: null }).store.remove();
  });
});

describe('ParakeetModelStore.read', () => {
  it('returns the verified bytes of every file and the vocabulary text', async () => {
    const { store, server } = makeStore();
    server.setDefault({ chunk: 41 });
    await store.install();
    const model = await store.read();
    sameBytes(model.encoder, ENCODER.bytes);
    sameBytes(model.decoder, DECODER.bytes);
    sameBytes(model.runtime, RUNTIME.bytes);
    should(model.vocabulary).equal('<unk>\nhello\nworld\n');
  });

  it('throws not-installed on an empty device, and when only some files are complete', async () => {
    const { store, server } = makeStore();
    const empty = await failure(store.read());
    should(empty.code).equal('not-installed');
    should(empty.message).equal('Parakeet is not installed on this device. Install it in Settings › Voice.');

    server.plan(VOCABULARY, { status: 503 });
    await failure(store.install());
    should((await failure(store.read())).code).equal('not-installed');
  });

  it('throws no-storage without Cache Storage', async () => {
    const error = await failure(makeStore({ caches: null }).store.read());
    should(error.code).equal('no-storage');
  });

  it('throws integrity when a stored part was tampered with', async () => {
    const { store, cache } = makeStore();
    await store.install();
    const stored = cache.entries.get(partKey('encoder', 1)) as Uint8Array;
    const tampered = stored.slice();
    tampered[3] = (tampered[3] as number) ^ 0x01;
    cache.entries.set(partKey('encoder', 1), tampered);
    const error = await failure(store.read());
    should(error.code).equal('integrity');
    should(error.message).equal(
      'Encoder changed on this device since it was installed. Remove Parakeet and install it again.',
    );
  });

  it('throws integrity when a stored part is shorter, longer than the file, or missing', async () => {
    const { store, cache } = makeStore();
    await store.install();
    const original = cache.entries.get(partKey('encoder', 0)) as Uint8Array;

    cache.entries.set(partKey('encoder', 0), original.slice(0, 10));
    should((await failure(store.read())).code).equal('integrity');

    cache.entries.set(partKey('encoder', 0), new Uint8Array(ENCODER.file.bytes + 1));
    should((await failure(store.read())).code).equal('integrity');

    cache.entries.delete(partKey('encoder', 0));
    should((await failure(store.read())).code).equal('integrity');

    cache.entries.set(partKey('encoder', 0), original);
    cache.entries.delete(partKey('encoder', 2));
    should((await failure(store.read())).code).equal('integrity');

    cache.entries.set(partKey('encoder', 0), new Uint8Array());
    should((await failure(store.read())).code).equal('integrity');
  });
});
