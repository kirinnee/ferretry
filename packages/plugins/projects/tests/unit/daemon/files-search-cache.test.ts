import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { type ProjectIndex, ProjectFolderRefused } from '../../../daemon/features/files/build.ts';
import {
  MAX_CACHED_PROJECTS,
  MAX_CONCURRENT_BUILDS,
  ProjectIndexCache,
  STALE_AFTER_MS,
} from '../../../daemon/features/files/cache.ts';
import { searchFiles } from '../../../daemon/features/files/search.ts';

const entry = (path: string) => ({ path, name: path.split('/').at(-1) ?? path });
const FILES = ['README.md', 'src/readme-notes.ts', 'docs/Guide.md', 'a/b/c/guide.txt', 'lib/other.ts'].map(entry);

describe('searchFiles', () => {
  test('a name that contains the text outranks a path that only does, keeping the index order within a rank', () => {
    const found = searchFiles(FILES, 'readme', 10);

    expect(found.files.map(file => file.path)).toEqual(['README.md', 'src/readme-notes.ts']);
    const byPath = searchFiles(FILES, 'docs', 10);
    expect(byPath.files.map(file => file.path)).toEqual(['docs/Guide.md']);
    // 'b/c' is only in a path; 'guide' is in two names — names first.
    expect(searchFiles(FILES, 'guide', 10).files.map(file => file.path)).toEqual(['docs/Guide.md', 'a/b/c/guide.txt']);
    expect(searchFiles(FILES, 'a/b', 10).files.map(file => file.path)).toEqual(['a/b/c/guide.txt']);
  });

  test('the match is case-folded, and the total counts every match before the limit cuts the answer', () => {
    const found = searchFiles(FILES, 'GUIDE', 1);

    expect(found.files.map(file => file.path)).toEqual(['docs/Guide.md']);
    expect(found.total).toBe(2);
  });

  test('no query lists the top of the index in its own order; nothing matching is an empty answer, not an error', () => {
    expect(searchFiles(FILES, undefined, 2).files.map(file => file.path)).toEqual(['README.md', 'src/readme-notes.ts']);
    expect(searchFiles(FILES, undefined, 2).total).toBe(5);
    expect(searchFiles(FILES, 'zzz', 5)).toEqual({ files: [], total: 0 });
  });
});

const index = (marker: string): ProjectIndex => ({
  files: [entry(`${marker}.ts`)],
  summary: {
    builtAt: '2026-11-22T00:00:00.000Z' as Instant,
    indexed: 1,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [],
    nestedWorktrees: [],
  },
});

/** A build the test finishes by hand, so "while it runs" can be observed. */
function manualBuild() {
  const calls: { path: string; finish: (value: ProjectIndex) => void; fail: (error: Error) => void }[] = [];
  const build = (path: string) =>
    new Promise<ProjectIndex>((resolve, reject) => {
      calls.push({ path, finish: resolve, fail: reject });
    });
  return { build, calls };
}

describe('ProjectIndexCache', () => {
  test('the first read waits for the build; a later one answers from memory and builds nothing', async () => {
    const { build, calls } = manualBuild();
    let now = 0;
    const cache = new ProjectIndexCache(build, () => now);

    const first = cache.read('p', '/work/p');
    calls[0]?.finish(index('one'));
    now += STALE_AFTER_MS - 1;
    const second = await cache.read('p', '/work/p');

    expect((await first).index.files[0]?.path).toBe('one.ts');
    expect(second).toEqual({ index: index('one'), rebuilding: false });
    expect(calls).toHaveLength(1);
  });

  test('a stale index is answered at once and rebuilt behind the answer, one build at a time', async () => {
    const { build, calls } = manualBuild();
    let now = 0;
    const cache = new ProjectIndexCache(build, () => now);
    const first = cache.read('p', '/work/p');
    calls[0]?.finish(index('old'));
    await first;

    now += STALE_AFTER_MS;
    const during = await cache.read('p', '/work/p');
    const joined = await cache.read('p', '/work/p');
    calls[1]?.finish(index('new'));
    await Promise.resolve();
    await Promise.resolve();
    const after = await cache.read('p', '/work/p');

    expect(during.index.files[0]?.path).toBe('old.ts');
    expect(during.rebuilding).toBe(true);
    expect(joined.rebuilding).toBe(true);
    expect(calls).toHaveLength(2);
    expect(after.index.files[0]?.path).toBe('new.ts');
    expect(after.rebuilding).toBe(false);
  });

  test('a rescan starts a rebuild now and answers without waiting; a second rescan joins it', async () => {
    const { build, calls } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);
    const first = cache.read('p', '/work/p');
    calls[0]?.finish(index('a'));
    await first;

    const started = cache.rescan('p', '/work/p');
    const joined = cache.rescan('p', '/work/p');

    expect(started.rebuilding).toBe(true);
    expect(started.index?.files[0]?.path).toBe('a.ts');
    expect(joined.rebuilding).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('status never waits: a project never built starts its first build and answers none yet', async () => {
    const { build, calls } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);

    const status = cache.status('p', '/work/p');

    expect(status).toEqual({ index: undefined, rebuilding: true });
    expect(calls).toHaveLength(1);
    calls[0]?.finish(index('a'));
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.status('p', '/work/p').index?.files[0]?.path).toBe('a.ts');
  });

  test('a failed first build throws to the reader and is not remembered; a failed rebuild keeps the old index and waits a stale interval', async () => {
    const { build, calls } = manualBuild();
    let now = 0;
    const cache = new ProjectIndexCache(build, () => now);
    const refused = cache.read('p', '/work/p');
    calls[0]?.fail(new Error('refused'));
    await expect(refused).rejects.toThrow('refused');

    const retry = cache.read('p', '/work/p');
    calls[1]?.finish(index('ok'));
    await retry;
    now += STALE_AFTER_MS;
    await cache.read('p', '/work/p');
    calls[2]?.fail(new Error('later'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const kept = await cache.read('p', '/work/p');

    expect(kept.index.files[0]?.path).toBe('ok.ts');
    expect(kept.rebuilding).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test('holds a bounded number of projects: the oldest idle one goes first', async () => {
    const built: string[] = [];
    const cache = new ProjectIndexCache(
      async path => {
        built.push(path);
        return index(path.slice(1));
      },
      () => 0,
    );

    for (let number = 0; number <= MAX_CACHED_PROJECTS; number++) await cache.read(`p${number}`, `/p${number}`);
    built.length = 0;
    await cache.read('p0', '/p0');
    await cache.read(`p${MAX_CACHED_PROJECTS}`, `/p${MAX_CACHED_PROJECTS}`);

    expect(built).toEqual(['/p0']);
  });
});

describe('ProjectIndexCache bounds', () => {
  test('runs a bounded number of builds at once; the rest wait their turn', async () => {
    const { build, calls } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);

    for (let number = 0; number < MAX_CACHED_PROJECTS; number++) void cache.read(`p${number}`, `/p${number}`);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(MAX_CONCURRENT_BUILDS);
    calls[0]?.finish(index('one'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.length).toBeLessThanOrEqual(MAX_CONCURRENT_BUILDS + 1);
  });

  test('when every held project is running, one more is refused as busy and nothing grows past the bound', async () => {
    const { build } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);
    for (let number = 0; number < MAX_CACHED_PROJECTS; number++) void cache.read(`p${number}`, `/p${number}`);

    const busy = await cache.read('extra', '/extra').catch((error: unknown) => error);
    const status = (() => {
      try {
        return cache.status('extra', '/extra');
      } catch (error) {
        return error;
      }
    })();

    expect(busy).toMatchObject({ name: 'IndexCacheBusy' });
    expect(status).toMatchObject({ name: 'IndexCacheBusy' });
    expect(cache.size()).toBeLessThanOrEqual(MAX_CACHED_PROJECTS);
  });

  test('a rebuild the privacy policy refuses discards the old index; one that merely failed keeps it', async () => {
    let now = 0;
    const outcomes: (ProjectIndex | Error)[] = [
      index('old'),
      new Error('disk hiccup'),
      new ProjectFolderRefused('private'),
    ];
    const cache = new ProjectIndexCache(
      async () => {
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next ?? index('none');
      },
      () => now,
    );
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    await cache.read('p', '/p');

    now += STALE_AFTER_MS;
    await cache.read('p', '/p');
    await settle();
    const afterHiccup = await cache.read('p', '/p');
    now += STALE_AFTER_MS;
    await cache.read('p', '/p');
    await settle();

    expect(afterHiccup.index.files[0]?.path).toBe('old.ts');
    expect(cache.status('p', '/p').index).toBeUndefined();
  });

  test('evicting a project whose build is still waiting for a slot cancels that build; it never starts later', async () => {
    const { build, calls } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);
    for (let number = 0; number < MAX_CONCURRENT_BUILDS; number++) void cache.read(`p${number}`, `/p${number}`);
    const queued = cache.read('queued', '/queued').catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.length).toBe(MAX_CONCURRENT_BUILDS);

    cache.evict('queued');
    calls[0]?.finish(index('one'));
    await new Promise(resolve => setTimeout(resolve, 0));

    // The freed slot is not given to the evicted build, and whoever waited for it is told the folder is unavailable.
    expect(calls.length).toBe(MAX_CONCURRENT_BUILDS);
    expect(calls.map(call => call.path)).not.toContain('/queued');
    expect(await queued).toMatchObject({ name: 'ProjectFolderRefused', reason: 'unavailable' });
    expect(cache.size()).toBe(MAX_CONCURRENT_BUILDS);
  });

  test('evict forgets a project at once', async () => {
    const cache = new ProjectIndexCache(
      async () => index('x'),
      () => 0,
    );
    await cache.read('p', '/p');

    cache.evict('p');

    expect(cache.status('p', '/p').index).toBeUndefined();
  });
});
