/**
 * O8 item 8, "have we fixed it with parallelism?": a bundle's files download side by side, at most `FILE_CONCURRENCY` at a
 * time, never more. Progress still only moves forward and ends at the total, one failure stops its siblings (what they
 * finished is kept, so the next Install resumes), and a cancel stops them all.
 *
 * Cache Storage is a `Map`; the network is a `fetch` whose responses this file releases by hand, so "how many are in flight
 * at once" is counted, not timed.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import {
  FILE_CONCURRENCY,
  type ModelCacheLike,
  type ModelCacheStorage,
  ModelInstallError,
  type ModelInstallProgress,
  type PinnedBundle,
  PinnedModelStore,
} from '../../../../app/lib/stt/model-store.ts';

const bytesOf = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + 7) % 251);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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
  async open(name: string): Promise<ModelCacheLike> {
    const existing = this.caches.get(name);
    if (existing !== undefined) return existing;
    const created = new MemoryCache();
    this.caches.set(name, created);
    return created;
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

const FILES = Array.from({ length: 6 }, (_, index) => {
  const bytes = bytesOf(40 + index * 7, index + 1);
  return { role: `file-${index}`, label: `File ${index}`, url: `https://models.test/f${index}`, bytes };
});

const BUNDLE: PinnedBundle = {
  name: 'Parallel',
  cache: 'fy:voice:parallel',
  keyRoot: '/fy-stt/parallel',
  versionLabel: 'parallel · 1',
  files: FILES.map(file => ({
    role: file.role,
    label: file.label,
    url: file.url,
    bytes: file.bytes.length,
    sha256: sha256Of(file.bytes),
  })),
};
const TOTAL = FILES.reduce((sum, file) => sum + file.bytes.length, 0);

const bodies = new Map(FILES.map(file => [file.url, file.bytes]));

/** A network that answers each request only when `release` is called, and counts what is waiting. */
const heldNetwork = (broken: ReadonlySet<string> = new Set()) => {
  const waiting: { url: string; go: () => void }[] = [];
  const live = { now: 0, max: 0 };
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    live.now += 1;
    live.max = Math.max(live.max, live.now);
    return new Promise<Response>((resolve, reject) => {
      let open = true;
      const finish = (): void => {
        if (open) live.now -= 1;
        open = false;
      };
      init?.signal?.addEventListener('abort', () => {
        finish();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      waiting.push({
        url,
        go: () => {
          finish();
          const body = bodies.get(url);
          resolve(
            broken.has(url) || body === undefined ? new Response(null, { status: 500 }) : new Response(body.slice()),
          );
        },
      });
    });
  };
  /** Answer everything now waiting, then let the store ask for the next files; true while anything was waiting. */
  const release = async (): Promise<boolean> => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const batch = waiting.splice(0);
    for (const request of batch) request.go();
    return batch.length > 0;
  };
  return { fetch, live, release, waiting };
};

const storeOver = (caches: MemoryCaches, fetch: (url: string, init?: RequestInit) => Promise<Response>) =>
  new PinnedModelStore({ bundle: BUNDLE, caches, fetch, partBytes: 64, now: () => new Date('2026-11-23T00:00:00Z') });

const drain = async (release: () => Promise<boolean>): Promise<void> => {
  for (let guard = 0; guard < 40 && (await release()); guard += 1);
};

describe('PinnedModelStore downloads the files of a bundle side by side', () => {
  it('has more than one file in flight, and never more than FILE_CONCURRENCY', async () => {
    const net = heldNetwork();
    const store = storeOver(new MemoryCaches(), net.fetch);
    const done = store.install();
    await drain(net.release);
    await done;
    should(FILE_CONCURRENCY).equal(3);
    should(net.live.max).equal(FILE_CONCURRENCY);
    should((await store.status()).state).equal('installed');
  });

  it('only ever moves progress forward, ends at the total and names the first unfinished file', async () => {
    const net = heldNetwork();
    const store = storeOver(new MemoryCaches(), net.fetch);
    const seen: ModelInstallProgress[] = [];
    const done = store.install({ onProgress: progress => seen.push(progress) });
    await drain(net.release);
    await done;
    const downloaded = seen.map(progress => progress.downloadedBytes);
    should(downloaded).eql([...downloaded].sort((a, b) => a - b));
    should(downloaded.at(-1)).equal(TOTAL);
    should(seen.every(progress => progress.totalBytes === TOTAL)).be.true();
    // The label never jumps back to an earlier file.
    const order = seen.map(progress => BUNDLE.files.findIndex(file => file.label === progress.label));
    should(order).eql([...order].sort((a, b) => a - b));
  });

  it('stops the siblings on one failure, throws that failure, keeps what finished, and resumes', async () => {
    const caches = new MemoryCaches();
    const broken = heldNetwork(new Set([FILES[1]?.url ?? '']));
    const failed = storeOver(caches, broken.fetch)
      .install()
      .catch((error: unknown) => error);
    await drain(broken.release);
    const failure = await failed;
    should(failure).be.instanceOf(ModelInstallError);
    should((failure as ModelInstallError).code).equal('network');
    should(broken.live.now).equal(0);

    const healthy = heldNetwork();
    const store = storeOver(caches, healthy.fetch);
    const again = store.install();
    await drain(healthy.release);
    await again;
    should((await store.status()).state).equal('installed');
  });

  it('cancels every file in flight when the signal aborts', async () => {
    const net = heldNetwork();
    const controller = new AbortController();
    const run = storeOver(new MemoryCaches(), net.fetch)
      .install({ signal: controller.signal })
      .catch((error: unknown) => error);
    await net.release().then(() => undefined);
    controller.abort();
    const failure = await run;
    should(failure).be.instanceOf(ModelInstallError);
    should((failure as ModelInstallError).code).equal('cancelled');
    should(net.live.now).equal(0);
  });
});
