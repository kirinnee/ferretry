/**
 * The cache over the kernel's REAL state port on a temp disk (never a real home): the files are `0600`, the folders
 * `0700`, a project's purge removes its folder, and a fresh process finds what an earlier one kept.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import type { Log } from '@ferretry/kernel/contract';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { PULLS_CACHE } from '../../contract/index.ts';
import { PullsCache } from '../../daemon/lib/cache/store.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const A1 = 'gha_1' as GitAccountId;
const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const home = await realpath(await mkdtemp(`${tmpdir()}/fy-pulls-cache-`));
  parents.push(home);
  await mkdir(join(home, 'state', 'pulls'), { recursive: true, mode: 0o700 });
  const make = () =>
    new PullsCache(
      state.createStatePort({ home, pluginId: 'pulls', files: [PULLS_CACHE], fs: state.createNodeHostFs() }),
      () => Date.now(),
      quiet,
    );
  return { home, make, cache: make() };
}

describe('the cache on a real disk', () => {
  test('files are 0600 in 0700 folders, survive a new process, and a purge removes the project folder', async () => {
    const w = await world();
    await w.cache.put(P1, A1, '/repos/o/r', { etag: 'W/"1"', body: { private: 'code' } });
    const folder = join(w.home, 'state', 'pulls', 'cache', P1);
    const [file] = await readdir(folder);
    expect((await stat(join(folder, file as string))).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);

    const later = w.make();
    expect(await later.get(P1, A1, '/repos/o/r')).toMatchObject({ etag: 'W/"1"', body: { private: 'code' } });
    expect(await later.usage(P1)).toMatchObject({ files: 1 });

    await later.purgeProject(P1);
    expect(await readdir(join(w.home, 'state', 'pulls', 'cache'))).toEqual([]);
  });

  test('reconcile on disk removes an account’s files and a missing project’s folder', async () => {
    const w = await world();
    const P2 = '22222222-2222-4222-8222-222222222222';
    await w.cache.put(P1, A1, '/a', { etag: 'e', body: 1 });
    await w.cache.put(P2, A1, '/a', { etag: 'e', body: 2 });
    await w.cache.reconcile(new Set([P1]), new Set());
    expect(await readdir(join(w.home, 'state', 'pulls', 'cache', P1))).toEqual([]);
    expect(await readdir(join(w.home, 'state', 'pulls', 'cache'))).not.toContain(P2);
  });
});
