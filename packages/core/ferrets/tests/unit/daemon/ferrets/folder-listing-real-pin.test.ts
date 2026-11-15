import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath, FerretId, WorkFolders } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { err, ok } from '@ferretry/std';
// The kernel's own pin registry and platform pinner: the REAL pin a ferret's `work` root hands out, not a fake.
import { platformRootPinner } from '../../../../../kernel/host/adapters/pinned/index.ts';
import { PinRegistry } from '../../../../../kernel/host/pins.ts';
import { KernelSessionRootPinner } from '../../../../daemon/adapters/session/filesystem/index.ts';
import { folderLister } from '../../../../daemon/lib/ferrets/folder-listing.ts';
import { SessionFilesystem } from '../../../../daemon/lib/session/filesystem/index.ts';
import { FakeSessionGit } from '../session/filesystem/support.ts';

/**
 * `FerretsApi.listFolder` over the REAL kernel pin (the composer's `@` menu): a ferret working in a folder that holds
 * the state home, a link out of the folder and a gitignored name. Only Git's answers are scripted.
 */
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const F1 = 'f1' as FerretId;

async function lister() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-folder-listing-`));
  parents.push(parent);
  const outside = await realpath(await mkdtemp(`${tmpdir()}/fy-folder-outside-`));
  parents.push(outside);
  const home = `${parent}/.ferretry`;
  await mkdir(`${home}/state`, { recursive: true });
  await writeFile(`${home}/api-token`, 'fy_admin_fixture');
  await mkdir(`${parent}/src`);
  await writeFile(`${parent}/src/a.ts`, 'source');
  await writeFile(`${outside}/loot.txt`, 'loot');
  await symlink(outside, `${parent}/out`);
  const folders: WorkFolders = {
    folderOf: () => parent as FencedPath,
    check: (_ferret, path) => (path.startsWith(parent) ? ok(path as FencedPath) : err('outside')),
  };
  const roots = rootsPortFor(
    nodeFs(() => 'r'),
    { home, plugin: 'ferrets', worktrees: `${home}-worktrees` },
    ['work'],
    () => folders,
    { pins: new PinRegistry(() => platformRootPinner()) },
  );
  const list = folderLister({
    folderOf: () => parent,
    filesystem: () =>
      new SessionFilesystem(
        new KernelSessionRootPinner(roots.root('work', { ferret: F1 })),
        new FakeSessionGit({ repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) }),
      ),
    mayTouch: () => true,
  });
  return { list };
}

describe('FerretsApi.listFolder behind the real kernel pin', () => {
  test('the root lists its names and badges the state home denied and a link out escaping, never offering their contents', async () => {
    const { list } = await lister();
    const root = await list(F1, '');
    const byName = (name: string) => root?.entries.find(entry => entry.name === name);
    expect(byName('src')).toEqual({ name: 'src', type: 'dir' });
    expect(byName('.ferretry')).toMatchObject({ denied: true });
    expect(byName('out')).toMatchObject({ escapes: true });
    expect(JSON.stringify(root)).not.toContain('loot');
    expect(JSON.stringify(root)).not.toContain('api-token');
  });

  test('a sub folder lists under the root, and the state home and the link out are refused to be listed into', async () => {
    const { list } = await lister();
    expect((await list(F1, 'src'))?.entries.map(entry => entry.name)).toEqual(['a.ts']);
    expect(await list(F1, '.ferretry').catch((error: unknown) => error)).toMatchObject({ status: 403, code: 'denied' });
    expect(await list(F1, 'out').catch((error: unknown) => error)).toMatchObject({
      status: 403,
      code: 'escapes_root',
    });
  });

  test('a path that climbs out or names another tree is refused, and a missing folder or a file is the browser’s own 404 / 400', async () => {
    const { list } = await lister();
    for (const path of ['..', '../etc', 'src/../..', '/etc'])
      expect(
        await list(F1, path).then(
          () => 'served',
          () => 'refused',
        ),
      ).toBe('refused');
    expect(await list(F1, 'nope').catch((error: unknown) => error)).toMatchObject({ status: 404 });
    expect(await list(F1, 'src/a.ts').catch((error: unknown) => error)).toMatchObject({ status: 400 });
  });
});
