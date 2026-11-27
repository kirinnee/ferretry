import { describe, expect, test } from 'bun:test';
import { discoverProject, isAmbientRoot } from '../../../daemon/lib/discover.ts';
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

describe('isAmbientRoot (V-B1 MUST 1)', () => {
  const home = '/home/owner';
  test.each([
    ['the home itself', '/home/owner'],
    ['a folder above the home', '/home'],
    ['the disk root', '/'],
    ['the OS temp folder', '/tmp/scratch/tool'],
    ['a macOS temp folder', '/private/var/folders/ab/cd/T/tool'],
    ['a worktrees folder', '/home/owner/work/.worktrees/clone'],
    ['a harness home inside the home', '/home/owner/.claude/plugins'],
    ['a key folder inside the home', '/home/owner/.ssh/repo'],
  ])('%s is not a project', (_name, root) => {
    expect(isAmbientRoot(root, home)).toBe(true);
  });
  test.each([
    ['a repository under the home', '/home/owner/work/alpha'],
    ['a repository outside the home', '/srv/code/alpha'],
    ['a repository under a home that itself sits in a temp folder', '/tmp/h/work/alpha'],
  ])('%s is one', (_name, root) => {
    expect(isAmbientRoot(root, root.startsWith('/tmp/h') ? '/tmp/h' : home)).toBe(false);
  });
});

describe('discoverProject refuses what git does not call a checkout, and Ferretry’s own home (V-B1)', () => {
  test('a root git does not name as the checkout of that repository registers nothing (MUST 2)', async () => {
    const over = registryOver(
      fakeMachine(['/work/odd'], { '/work/odd': '/work/odd/.git' }, [], { notCheckouts: ['/work/odd'] }),
    );
    await discoverProject({ folder: '/work/odd' }, over.machine, over.registry);
    expect(over.store.file.projects).toEqual([]);
  });
  test('a repository inside the imports fence (Ferretry’s own home) registers nothing', async () => {
    const over = registryOver(fakeMachine(['/fy/state/x'], { '/fy/state/x': '/fy/state/x/.git' }, ['/fy']));
    await discoverProject({ folder: '/fy/state/x' }, over.machine, over.registry);
    expect(over.store.file.projects).toEqual([]);
  });
  test('the owner’s tracked home and a repository in a temp folder register nothing', async () => {
    const over = registryOver(
      fakeMachine(['/home/owner', '/tmp/tool'], { '/home/owner': '/home/owner/.git', '/tmp/tool': '/tmp/tool/.git' }),
    );
    for (const folder of ['/home/owner', '/tmp/tool']) await discoverProject({ folder }, over.machine, over.registry);
    expect(over.store.file.projects).toEqual([]);
  });
});
