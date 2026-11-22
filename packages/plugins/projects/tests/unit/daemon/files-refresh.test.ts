import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { ProjectIndex } from '../../../daemon/features/files/build.ts';
import { ProjectIndexCache, STALE_AFTER_MS } from '../../../daemon/features/files/cache.ts';
import { FilesRefresh, folderInProject } from '../../../daemon/features/files/refresh.ts';

const index = (marker: string): ProjectIndex => ({
  files: [{ path: `${marker}.ts`, name: `${marker}.ts` }],
  summary: {
    builtAt: '2026-11-22T00:00:00.000Z' as Instant,
    indexed: 1,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [],
    nestedWorktrees: [],
  },
});

/** Builds the test finishes by hand, so "while it runs" can be observed. */
function manualBuild() {
  const calls: { path: string; finish: (value: ProjectIndex) => void; fail: (error: Error) => void }[] = [];
  const build = (path: string) =>
    new Promise<ProjectIndex>((resolve, reject) => {
      calls.push({ path, finish: resolve, fail: reject });
    });
  return { build, calls };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

/** A cache with `p` built once (marker `old`) on a clock the test moves. */
async function held() {
  const { build, calls } = manualBuild();
  const clock = { now: 0 };
  const cache = new ProjectIndexCache(build, () => clock.now);
  const first = cache.read('p', '/work/p');
  calls[0]?.finish(index('old'));
  await first;
  return { cache, calls, clock };
}

describe('ProjectIndexCache.invalidate (&F6061 U6)', () => {
  test('an index still fresh by the clock is answered old and rebuilt behind the answer once invalidated', async () => {
    const { cache, calls, clock } = await held();
    clock.now += 1_000;
    expect(await cache.read('p', '/work/p')).toEqual({ index: index('old'), rebuilding: false });

    cache.invalidate('p');
    const during = await cache.read('p', '/work/p');
    calls[1]?.finish(index('new'));
    await settle();
    const after = await cache.read('p', '/work/p');

    expect(during).toEqual({ index: index('old'), rebuilding: true });
    expect(after).toEqual({ index: index('new'), rebuilding: false });
    expect(calls).toHaveLength(2);
  });

  test('a burst of invalidations and reads is ONE build: a second read joins the one running', async () => {
    const { cache, calls } = await held();

    cache.invalidate('p');
    cache.invalidate('p');
    cache.invalidate('p');
    expect(calls).toHaveLength(1); // nothing is built until somebody reads
    await cache.read('p', '/work/p');
    cache.invalidate('p');
    await cache.read('p', '/work/p');
    await cache.read('p', '/work/p');

    expect(calls).toHaveLength(2);
  });

  test('a change that arrives while a build runs is not covered by it: the next read rebuilds once more', async () => {
    const { cache, calls } = await held();
    cache.invalidate('p');
    await cache.read('p', '/work/p'); // starts build 1 (index 1 of calls)

    cache.invalidate('p'); // a turn ended after that build began
    calls[1]?.finish(index('mid'));
    await settle();
    const next = await cache.read('p', '/work/p');
    calls[2]?.finish(index('last'));
    await settle();

    expect(next).toEqual({ index: index('mid'), rebuilding: true });
    expect(calls).toHaveLength(3);
    expect((await cache.read('p', '/work/p')).index).toEqual(index('last'));
    expect(calls).toHaveLength(3); // and then it is current: no fourth build
  });

  test('a rebuild that fails after an invalidation keeps the old index and is not retried on every read', async () => {
    const { cache, calls, clock } = await held();
    cache.invalidate('p');
    await cache.read('p', '/work/p');
    calls[1]?.fail(new Error('git is gone'));
    await settle();

    const again = await cache.read('p', '/work/p');
    expect(again).toEqual({ index: index('old'), rebuilding: false });
    expect(calls).toHaveLength(2);

    clock.now += STALE_AFTER_MS;
    await cache.read('p', '/work/p');
    expect(calls).toHaveLength(3);
  });

  test('a project that is not held is not created by an invalidation', async () => {
    const { build, calls } = manualBuild();
    const cache = new ProjectIndexCache(build, () => 0);

    cache.invalidate('never-read');

    expect(cache.size()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('folderInProject', () => {
  test('the project folder and anything below it match; a sibling that shares a prefix does not', () => {
    expect(folderInProject('/work/alpha', '/work/alpha')).toBe(true);
    expect(folderInProject('/work/alpha/', '/work/alpha')).toBe(true);
    expect(folderInProject('/work/alpha/.worktrees/x', '/work/alpha/')).toBe(true);
    expect(folderInProject('/work/alpha-2', '/work/alpha')).toBe(false);
    expect(folderInProject('/work', '/work/alpha')).toBe(false);
    expect(folderInProject('/anything', '/')).toBe(true);
  });
});

describe('FilesRefresh (fake ferrets events, fake clock)', () => {
  /** Two projects; ferret `a` works in alpha, `b` in beta's worktree, `c` somewhere else, `d` is unknown. */
  async function world() {
    const { build, calls } = manualBuild();
    const clock = { now: 0 };
    const cache = new ProjectIndexCache(build, () => clock.now);
    const refresh = new FilesRefresh(cache, {
      projects: async () => [
        { id: 'alpha', path: '/work/alpha' },
        { id: 'beta', path: '/work/beta' },
      ],
      folderOf: async ferret =>
        ({
          a: '/work/alpha/src',
          b: '/work/beta/.worktrees/x',
          c: '/elsewhere',
          l: '/work/alpha/link',
          g: '/work/alpha/gone',
        })[ferret as 'a' | 'b' | 'c' | 'l' | 'g'],
      // `alpha/link` is a symlink to the registered beta folder; `alpha/gone` resolves to nothing.
      resolve: async path =>
        path === '/work/alpha/link' ? '/work/beta' : path === '/work/alpha/gone' ? undefined : path,
    });
    for (const id of ['alpha', 'beta']) {
      const first = cache.read(id, `/work/${id}`);
      calls.at(-1)?.finish(index(id));
      await first;
    }
    const builtBefore = calls.length;
    /** Reads both projects; the ones that were invalidated start a rebuild. */
    const probe = async (): Promise<string[]> => {
      const rebuilding: string[] = [];
      for (const id of ['alpha', 'beta']) if ((await cache.read(id, `/work/${id}`)).rebuilding) rebuilding.push(id);
      return rebuilding;
    };
    return { refresh, probe, calls, builtBefore, cache, clock };
  }

  test('a ferret going idle (its turn ended) in a project refreshes that project only', async () => {
    const { refresh, probe } = await world();

    await refresh.ferretChanged({ ferret: 'a', state: 'idle' });

    expect(await probe()).toEqual(['alpha']);
  });

  test('a ferret in a linked worktree under a project refreshes that project; a stopped ferret does too', async () => {
    const { refresh, probe } = await world();

    await refresh.ferretChanged({ ferret: 'b', state: 'stopped' });

    expect(await probe()).toEqual(['beta']);
  });

  test('a ferret started in a link that points at project beta refreshes beta, not the project the link sits in (alias)', async () => {
    const { refresh, probe } = await world();

    await refresh.ferretChanged({ ferret: 'l', state: 'idle' });

    expect(await probe()).toEqual(['beta']);
  });

  test('a ferret folder that resolves to nothing is judged by its spelling', async () => {
    const { refresh, probe } = await world();

    await refresh.ferretChanged({ ferret: 'g', state: 'idle' });

    expect(await probe()).toEqual(['alpha']);
  });

  test('working, a gone ferret, a ferret outside every project and an unknown ferret refresh nothing', async () => {
    const { refresh, probe, calls, builtBefore } = await world();

    await refresh.ferretChanged({ ferret: 'a', state: 'working' });
    await refresh.ferretChanged({ ferret: 'a', state: 'starting' });
    await refresh.ferretChanged({ ferret: 'a', gone: true });
    await refresh.ferretChanged({ ferret: 'a' });
    await refresh.ferretChanged({ ferret: 'c', state: 'idle' });
    await refresh.ferretChanged({ ferret: 'd', state: 'idle' });

    expect(await probe()).toEqual([]);
    expect(calls).toHaveLength(builtBefore);
  });

  test('many turn ends and many readers in a project cost one build', async () => {
    const { refresh, probe, calls, builtBefore } = await world();

    for (let turn = 0; turn < 5; turn += 1) await refresh.ferretChanged({ ferret: 'a', state: 'idle' });
    await probe();
    await probe();
    await refresh.ferretChanged({ ferret: 'a', state: 'idle' });
    await probe();

    expect(calls).toHaveLength(builtBefore + 1);
  });

  test('a project registered again is refreshed; a removed one is forgotten at once', async () => {
    const { refresh, probe, cache } = await world();

    refresh.registered('beta');
    expect(await probe()).toEqual(['beta']);

    refresh.removed('alpha');
    expect(cache.size()).toBe(1);
  });
});
