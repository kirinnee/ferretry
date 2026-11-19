import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { Log } from '@ferretry/kernel/contract';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { MAX_CACHE_BYTES_PER_PROJECT, MAX_CACHE_ENTRY_BYTES, PULLS_CACHE } from '../../contract/index.ts';
import { PullsCache } from '../../daemon/lib/cache/store.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const A1 = 'gha_1' as GitAccountId;
const A2 = 'gha_2' as GitAccountId;
const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

function world() {
  let now = 1_000;
  const folder = new MemoryStateFolder(() => now);
  const cache = new PullsCache(folder.port([PULLS_CACHE]), () => now, quiet);
  return { folder, cache, tick: () => (now += 1_000) };
}
const big = (megabytes: number): string => 'x'.repeat(megabytes * 1024 * 1024);

describe('the per-project cache', () => {
  test('a fresh process reads what an earlier one kept (its index is rebuilt from the folder)', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: 'first' });
    const later = new PullsCache(w.folder.port([PULLS_CACHE]), () => 5_000, quiet);
    const before = await later.usage(P1);
    expect(before.files).toBe(1);
    expect(before.bytes).toBeGreaterThan(0);
    await later.put(P1, A1, '/b', { etag: 'e', body: 'second' });
    expect(await later.usage(P1)).toMatchObject({ files: 2 });
  });

  test('room is made BEFORE a write: a file that will not go means the new answer is not written, and the bound holds', async () => {
    const w = world();
    const warned: string[] = [];
    const port = w.folder.port([PULLS_CACHE]);
    const stuck = new PullsCache({ ...port, remove: async () => Promise.reject(new Error('read-only')) }, () => 1_000, {
      ...quiet,
      warn: message => void warned.push(message),
    });
    for (const n of [1, 2, 3, 4, 5]) await stuck.put(P1, A1, `/p${n}`, { etag: 'e', body: big(7) });
    expect(warned).toEqual(['a cache file could not be removed']);
    // Four fit (28 MiB); the fifth needed room that could not be made, so it was never written.
    expect(await stuck.get(P1, A1, '/p5')).toBeUndefined();
    expect(await stuck.get(P1, A1, '/p4')).toBeDefined();
    const usage = await stuck.usage(P1);
    expect(usage.files).toBe(4);
    expect(usage.bytes).toBeLessThanOrEqual(MAX_CACHE_BYTES_PER_PROJECT);
    // The folder itself never went over the bound, not even for a moment.
    let onDisk = 0;
    for (const bytes of w.folder.bytes.values()) onDisk += bytes.byteLength;
    expect(onDisk).toBeLessThanOrEqual(MAX_CACHE_BYTES_PER_PROJECT);
    // A purge that cannot remove a file says so and leaves the retry to the sweep.
    await stuck.purgeProject(P1);
    expect(warned).toEqual([
      'a cache file could not be removed',
      "a removed project's cache could not be deleted; the next sweep retries",
    ]);
  });

  test('the folder never holds more than the bound while a write is in progress', async () => {
    const w = world();
    const port = w.folder.port([PULLS_CACHE]);
    let high = 0;
    const watched = new PullsCache(
      {
        ...port,
        write: async (...args: Parameters<typeof port.write>) => {
          const written = await port.write(...args);
          let onDisk = 0;
          for (const bytes of w.folder.bytes.values()) onDisk += bytes.byteLength;
          high = Math.max(high, onDisk);
          return written;
        },
      } as typeof port,
      () => 1_000,
      quiet,
    );
    for (const n of [1, 2, 3, 4, 5, 6]) {
      w.tick();
      await watched.put(P1, A1, `/p${n}`, { etag: 'e', body: big(7) });
    }
    expect(high).toBeLessThanOrEqual(MAX_CACHE_BYTES_PER_PROJECT);
  });

  test('rewriting one answer replaces it: its old bytes are not counted twice', async () => {
    const w = world();
    for (const n of [1, 2, 3]) await w.cache.put(P1, A1, `/p${n}`, { etag: 'e', body: big(7) });
    await w.cache.put(P1, A1, '/p3', { etag: 'e2', body: big(7) });
    expect(await w.cache.usage(P1)).toMatchObject({ files: 3 });
    expect(await w.cache.get(P1, A1, '/p1')).toBeDefined();
  });

  test('a write whose read began before a purge writes nothing (project, then account)', async () => {
    const w = world();
    const early = w.cache.stamp(P1, A1);
    await w.cache.purgeProject(P1);
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: { a: 1 } }, early);
    expect(w.folder.bytes.size).toBe(0);
    // A read that began AFTER the purge is a fresh one and is kept.
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: { a: 1 } }, w.cache.stamp(P1, A1));
    expect(w.folder.bytes.size).toBe(1);

    const before = w.cache.stamp(P1, A1);
    await w.cache.purgeAccount(A1);
    await w.cache.put(P1, A1, '/b', { etag: 'e', body: { b: 1 } }, before);
    expect(w.folder.bytes.size).toBe(0);
    // The purge moved this account's stamp, not another's.
    expect(w.cache.stamp(P1, A1)).not.toBe(before);
    expect(w.cache.stamp(P1, A2)).toBe(before);
  });

  test('a purge that is still queued already fences a write that follows it', async () => {
    const w = world();
    const early = w.cache.stamp(P1, A1);
    const purge = w.cache.purgeProject(P1); // not awaited: the fence is up before it runs
    const write = w.cache.put(P1, A1, '/a', { etag: 'e', body: { a: 1 } }, early);
    await Promise.all([purge, write]);
    expect(w.folder.bytes.size).toBe(0);
  });

  test('remove then reconnect of the same account id finds no old file', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: { private: 'code' } });
    await w.cache.put(P2, A1, '/a', { etag: 'e', body: { private: 'code' } });
    await w.cache.purgeAccount(A1);
    // Reconnected: the same id, nothing left to read.
    expect(await w.cache.get(P1, A1, '/a')).toBeUndefined();
    expect(await w.cache.get(P2, A1, '/a')).toBeUndefined();
    expect(w.folder.bytes.size).toBe(0);
  });

  test('keeps an answer, its validator and its Link, per account', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/p', {
      etag: 'W/"1"',
      link: '<https://api.github.com/p?page=2>; rel="next"',
      body: [1],
    });
    expect(await w.cache.get(P1, A1, '/p')).toMatchObject({
      etag: 'W/"1"',
      body: [1],
      link: expect.stringContaining('page=2'),
    });
    expect(await w.cache.get(P1, A2, '/p')).toBeUndefined();
    expect(await w.cache.get(P2, A1, '/p')).toBeUndefined();
  });

  test('a damaged or foreign file is dropped and read as absent', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/p', { etag: 'e', body: 1 });
    const [name] = [...w.folder.bytes.keys()];
    w.folder.bytes.set(name as string, new TextEncoder().encode('not json'));
    expect(await w.cache.get(P1, A1, '/p')).toBeUndefined();
    expect(w.folder.bytes.size).toBe(0);
  });

  test('is bounded to 32 MiB per project, oldest out first, and never touches another project', async () => {
    const w = world();
    await w.cache.put(P2, A1, '/other', { etag: 'e', body: big(5) });
    for (const n of [1, 2, 3, 4, 5]) {
      w.tick();
      await w.cache.put(P1, A1, `/p${n}`, { etag: 'e', body: big(7) }); // 35 MiB asked, 32 allowed
    }
    const usage = await w.cache.usage(P1);
    expect(usage.bytes).toBeLessThanOrEqual(MAX_CACHE_BYTES_PER_PROJECT);
    expect(await w.cache.get(P1, A1, '/p1')).toBeUndefined(); // the oldest went
    expect(await w.cache.get(P1, A1, '/p5')).toBeDefined(); // the newest stayed
    expect(await w.cache.get(P2, A1, '/other')).toBeDefined();
  });

  test('one answer over 8 MiB is served by the caller but not kept', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/huge', { etag: 'e', body: big(MAX_CACHE_ENTRY_BYTES / 1024 / 1024 + 1) });
    expect(await w.cache.usage(P1)).toEqual({ bytes: 0, files: 0 });
  });

  test('a folder that will not go (still in use) does not fail a purge or a sweep', async () => {
    const w = world();
    const port = w.folder.port([PULLS_CACHE]);
    const cache = new PullsCache(
      { ...port, removeEmptyDirectory: async () => Promise.reject(new Error('busy')) },
      () => 1_000,
      quiet,
    );
    await cache.put(P1, A1, '/a', { etag: 'e', body: { a: 1 } });
    await cache.put(P2, A1, '/a', { etag: 'e', body: { a: 1 } });
    await cache.purgeAccount(A1);
    await cache.put(P1, A1, '/a', { etag: 'e', body: { a: 1 } });
    await cache.reconcile(new Set(), new Set());
    await cache.purgeProject(P1);
    expect(w.folder.bytes.size).toBe(0);
  });

  test('purging a project deletes its files and nothing else', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: 1 });
    await w.cache.put(P1, A2, '/b', { etag: 'e', body: 2 });
    await w.cache.put(P2, A1, '/a', { etag: 'e', body: 3 });
    await w.cache.purgeProject(P1);
    expect(await w.cache.get(P1, A1, '/a')).toBeUndefined();
    expect(await w.cache.get(P1, A2, '/b')).toBeUndefined();
    expect(await w.cache.get(P2, A1, '/a')).toBeDefined();
    expect(await w.cache.usage(P1)).toEqual({ bytes: 0, files: 0 });
  });

  test('purging an account deletes its files in every project', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: 1 });
    await w.cache.put(P2, A1, '/a', { etag: 'e', body: 2 });
    await w.cache.put(P2, A2, '/a', { etag: 'e', body: 3 });
    await w.cache.purgeAccount(A1);
    expect(await w.cache.get(P1, A1, '/a')).toBeUndefined();
    expect(await w.cache.get(P2, A1, '/a')).toBeUndefined();
    expect(await w.cache.get(P2, A2, '/a')).toBeDefined();
  });

  test('reconcile drops a project that is gone and an account that is gone, and keeps the rest', async () => {
    const w = world();
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: 1 });
    await w.cache.put(P1, A2, '/a', { etag: 'e', body: 2 });
    await w.cache.put(P2, A1, '/a', { etag: 'e', body: 3 });
    // A file that is no account's is dropped as well.
    const port = w.folder.port([PULLS_CACHE]);
    await port.write(PULLS_CACHE, '{}' as never, `${P1}/stray.json`);
    const early = w.cache.stamp(P2, A1);
    const earlyA2 = w.cache.stamp(P1, A2);
    await w.cache.reconcile(new Set([P1]), new Set([A1]));
    expect(await port.read(PULLS_CACHE, `${P1}/stray.json`)).toMatchObject({ value: undefined });
    // What it removed fences a read that was already out.
    await w.cache.put(P2, A1, '/late', { etag: 'e', body: {} }, early);
    await w.cache.put(P1, A2, '/late', { etag: 'e', body: {} }, earlyA2);
    expect(await w.cache.get(P2, A1, '/late')).toBeUndefined();
    expect(await w.cache.get(P1, A2, '/late')).toBeUndefined();
    expect(await w.cache.get(P1, A1, '/a')).toBeDefined();
    expect(await w.cache.get(P1, A2, '/a')).toBeUndefined();
    expect(await w.cache.get(P2, A1, '/a')).toBeUndefined();
  });

  test('a project id that is not a plain name is refused before it reaches a path', async () => {
    const w = world();
    await w.cache.put('../escape', A1, '/a', { etag: 'e', body: 1 });
    await w.cache.put('a/b', A1, '/a', { etag: 'e', body: 1 });
    expect(w.folder.bytes.size).toBe(0);
    expect(await w.cache.get('../escape', A1, '/a')).toBeUndefined();
  });
});
