import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { ProjectInfo, ProjectsFile } from '../../../contract/index.ts';
import type { RegistryStore } from '../../../daemon/lib/ports.ts';
import { ProjectRegistry } from '../../../daemon/lib/registry.ts';
import { fakeMachine } from './support.ts';

/** The registry file in memory, with the same one-at-a-time update the kernel's state port gives. */
function memoryStore(initial: readonly ProjectInfo[] = []): RegistryStore & { file: ProjectsFile; reads: number } {
  let chain: Promise<unknown> = Promise.resolve();
  const store = {
    file: { format: 1, projects: [...initial] } as ProjectsFile,
    reads: 0,
    read: async () => store.file.projects,
    update: (change: (current: ProjectsFile) => ProjectsFile) => {
      const run = chain.then(async () => {
        await Promise.resolve();
        store.file = change(store.file);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

function registry(machine = fakeMachine(), store = memoryStore()) {
  let counter = 0;
  const said: string[] = [];
  const instance = new ProjectRegistry({
    store,
    folders: machine,
    clock: { now: () => '2026-11-07T09:00:00.000Z' as Instant },
    newId: () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`,
    registered: id => said.push(`registered ${id}`),
    removed: id => said.push(`removed ${id}`),
  });
  return { registry: instance, store, said, machine };
}

describe('ProjectRegistry project-path boundary', () => {
  test('rejects a relative path before the filesystem or git is touched', async () => {
    const { registry: projects, machine, store } = registry();

    const result = await projects.register({ kind: 'new-folder', path: 'relative-name', initializeGit: true });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({ code: 'registration_failed', message: 'project path must be absolute' });
    expect(machine.calls).toEqual([]);
    expect(store.file.projects).toEqual([]);
  });

  test('still registers a valid absolute path through the direct service', async () => {
    const { registry: projects, store, said } = registry(fakeMachine(['/work/project']));

    const result = await projects.register({ kind: 'existing-folder', path: '/work/project' });

    expect(result.ok && result.value).toMatchObject({
      name: 'project',
      path: '/work/project',
      source: 'existing-folder',
    });
    expect(store.file.projects).toHaveLength(1);
    expect(said).toHaveLength(1);
  });

  test('keeps a trailing-slash path as one record with the folder name', async () => {
    const { registry: projects } = registry(fakeMachine(['/work/project']));

    const result = await projects.register({ kind: 'existing-folder', path: '/work/project/', name: 'Mine' });

    expect(result.ok && result.value).toMatchObject({ name: 'Mine', path: '/work/project' });
  });
});

describe('ProjectRegistry failure paths', () => {
  test('refuses to register a path that is not an existing directory', async () => {
    const { registry: projects, store } = registry();

    const result = await projects.register({ kind: 'existing-folder', path: '/work/absent' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('project path is not an existing directory');
    expect(store.file.projects).toEqual([]);
  });

  test('registers a folder without a git attachment when it is not a work tree', async () => {
    const { registry: projects } = registry(fakeMachine(['/work/plain']));

    const result = await projects.register({ kind: 'existing-folder', path: '/work/plain' });

    expect(result.ok && result.value.git).toBeUndefined();
  });

  test('attaches the repository common directory for a folder that is a git work tree', async () => {
    const { registry: projects } = registry(fakeMachine(['/work/repo'], { '/work/repo': '/work/repo/.git' }));

    const result = await projects.register({ kind: 'existing-folder', path: '/work/repo' });

    expect(result.ok && result.value.git).toEqual({ commonDirectory: '/work/repo/.git' });
  });

  test('a clone address the schema refuses never reaches git', async () => {
    const { registry: projects, machine } = registry();

    const result = await projects.register({ kind: 'clone', url: 'ext::sh -c id', path: '/work/x' } as never);

    expect(result.ok).toBe(false);
    expect(machine.calls.filter(call => call.startsWith('git'))).toEqual([]);
  });

  test('a clone and a new folder with git are made, then registered with their source', async () => {
    const { registry: projects, machine } = registry(fakeMachine(['/work']));

    const cloned = await projects.register({ kind: 'clone', url: 'https://host/r.git', path: '/work/r' });
    const fresh = await projects.register({ kind: 'new-folder', path: '/work/n', initializeGit: true });

    expect(cloned.ok && cloned.value).toMatchObject({ source: 'clone', git: { commonDirectory: '/work/r/.git' } });
    expect(fresh.ok && fresh.value).toMatchObject({ source: 'new-folder', git: { commonDirectory: '/work/n/.git' } });
    expect(machine.calls).toContain('git clone https://host/r.git /work/r');
  });

  test('a new folder that already exists is refused and nothing is recorded', async () => {
    const { registry: projects, store } = registry(fakeMachine(['/work/there']));

    const result = await projects.register({ kind: 'new-folder', path: '/work/there', initializeGit: false });

    expect(result.ok).toBe(false);
    expect(store.file.projects).toEqual([]);
  });

  test('a new folder or a clone inside the fence is refused BEFORE anything is made there', async () => {
    const machine = fakeMachine(['/home/me/.ferretry'], {}, ['/home/me/.ferretry']);
    const { registry: projects, store } = registry(machine);

    const made = await projects.register({ kind: 'new-folder', path: '/home/me/.ferretry/x', initializeGit: true });
    const cloned = await projects.register({ kind: 'clone', url: 'https://host/r.git', path: '/home/me/.ferretry/r' });

    expect(made.ok).toBe(false);
    expect(cloned.ok).toBe(false);
    expect(machine.calls.some(call => call.startsWith('mkdir') || call.startsWith('git '))).toBe(false);
    expect(store.file.projects).toEqual([]);
  });
});

describe('ProjectRegistry registrations at once', () => {
  test('makes one record for two registrations of one repository and keeps every other one', async () => {
    const machine = fakeMachine(['/r/repo', '/r/a', '/r/b', '/r/c'], { '/r/repo': '/r/repo/.git' });
    const { registry: projects, store, said } = registry(machine);

    const registered = await Promise.all([
      projects.register({ kind: 'confirmed-discovery', path: '/r/repo' }),
      projects.register({ kind: 'existing-folder', path: '/r/repo' }),
      ...['/r/a', '/r/b', '/r/c'].map(path => projects.register({ kind: 'existing-folder', path })),
    ]);

    expect(registered[0]?.ok && registered[0].value.id).toBe(registered[1]?.ok && registered[1].value.id);
    expect(store.file.projects.map(project => project.name).sort()).toEqual(['a', 'b', 'c', 'repo']);
    expect(said).toHaveLength(4);
  });

  test('two worktrees of one repository are one project (the common directory is the identity)', async () => {
    const machine = fakeMachine(['/r/main', '/r/wt'], { '/r/main': '/r/main/.git', '/r/wt': '/r/main/.git' });
    const { registry: projects, store } = registry(machine);

    const first = await projects.register({ kind: 'existing-folder', path: '/r/main' });
    const second = await projects.register({ kind: 'existing-folder', path: '/r/wt' });

    expect(second.ok && second.value.id).toBe(first.ok && first.value.id);
    expect(store.file.projects).toHaveLength(1);
  });
});

describe('ProjectRegistry removal', () => {
  test('forgets the project, answers the record, and says so once; the folder is untouched', async () => {
    const { registry: projects, store, said, machine } = registry(fakeMachine(['/w/p']));
    const added = await projects.register({ kind: 'existing-folder', path: '/w/p' });
    if (!added.ok) throw new Error('setup');

    const removed = await projects.remove(added.value.id);

    expect(removed.ok && removed.value.id).toBe(added.value.id);
    expect(store.file.projects).toEqual([]);
    expect(said.filter(line => line.startsWith('removed'))).toHaveLength(1);
    expect(machine.directories.has('/w/p')).toBe(true);
  });

  test('a project that is not there is not_found and nothing is announced', async () => {
    const { registry: projects, said } = registry();

    const result = await projects.remove('00000000-0000-4000-8000-0000000000ff' as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    expect(said).toEqual([]);
  });
});
