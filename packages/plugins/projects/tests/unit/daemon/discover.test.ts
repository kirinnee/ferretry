import { describe, expect, test } from 'bun:test';
import { discoverProject } from '../../../daemon/lib/discover.ts';
import { fakeMachine, registryOver } from './support.ts';

const machine = () =>
  fakeMachine(['/work/alpha', '/work/alpha/src', '/work/alpha-wt', '/work/plain', '/work/bare', '/work/sub'], {
    '/work/alpha': '/work/alpha/.git',
    '/work/alpha/src': '/work/alpha/.git',
    '/work/alpha-wt': '/work/alpha/.git',
    '/work/bare': '/work/bare.git',
    '/work/sub': '/work/super/.git/modules/sub',
  });

describe('discoverProject (W-42)', () => {
  test('an unregistered repository is registered once, as the main checkout, whichever folder the ferret stands in', async () => {
    const over = registryOver(machine());
    for (const folder of ['/work/alpha/src', '/work/alpha-wt', '/work/alpha'])
      await discoverProject({ folder }, over.machine, over.registry);
    expect(over.store.file.projects).toHaveLength(1);
    expect(over.store.file.projects[0]).toMatchObject({ path: '/work/alpha', source: 'existing-folder' });
    expect(over.said).toHaveLength(1);
  });

  test('a registered repository is left exactly as it is, by folder or by git directory', async () => {
    const over = registryOver(machine());
    await over.registry.register({ kind: 'existing-folder', path: '/work/alpha', name: 'Mine' });
    const before = structuredClone(over.store.file);
    await discoverProject({ folder: '/work/alpha' }, over.machine, over.registry);
    await discoverProject({ folder: '/work/alpha-wt' }, over.machine, over.registry);
    expect(over.store.file).toEqual(before);
  });

  test('a folder that is no repository, a bare repository and a submodule register nothing', async () => {
    const over = registryOver(machine());
    for (const folder of ['/work/plain', '/work/bare', '/work/sub'])
      await discoverProject({ folder }, over.machine, over.registry);
    expect(over.store.file.projects).toEqual([]);
  });
});
