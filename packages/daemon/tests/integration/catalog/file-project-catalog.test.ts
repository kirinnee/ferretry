import { afterEach, describe, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import { FileProjectCatalog } from '../../../src/adapters/catalog/index.ts';

let root: string | undefined;
let stray: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (stray !== undefined) await rm(stray, { recursive: true, force: true });
  root = undefined;
  stray = undefined;
});

describe('FileProjectCatalog project-path boundary', () => {
  it('rejects a relative path before the filesystem or Git is touched', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-path-'));
    const projects = new FileProjectCatalog(join(root, 'projects.json'), () => '2026-08-04T00:00:00.000Z');
    // A unique single-segment relative name. Before the fix, resolve() turned this into an
    // absolute path under the daemon's own cwd, mkdir created it, and `git init` ran inside
    // it. The shared protocol schema must refuse it before any of that work happens.
    const relativePath = `ferretry-reject-${randomUUID()}`;
    stray = resolve(relativePath);

    await should(projects.register({ kind: 'new-folder', path: relativePath, initializeGit: true })).be.rejectedWith(
      'project path must be absolute',
    );

    // No project record was persisted...
    should(await projects.projects()).deepEqual([]);
    // ...and no directory was created where resolve(relative) used to land.
    should(await stat(stray).catch(() => undefined)).be.undefined();
  });

  it('still registers a valid absolute path through the direct adapter', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-path-'));
    const projects = new FileProjectCatalog(join(root, 'projects.json'), () => '2026-08-04T00:00:00.000Z');
    const absolute = join(root, 'project');
    await mkdir(absolute, { recursive: true });

    const registered = await projects.register({ kind: 'existing-folder', path: absolute });

    should(registered).match({ name: 'project', path: absolute, source: 'existing-folder' });
    should(await projects.projects()).deepEqual([registered]);
  });
});

describe('FileProjectCatalog failure paths', () => {
  it('surfaces a registry read failure that is not a missing file', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-registry-'));
    const registry = join(root, 'projects.json');
    await mkdir(registry);

    await should(new FileProjectCatalog(registry).projects()).be.rejected();
  });

  it('refuses to register a path that is not an existing directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-missing-'));
    const projects = new FileProjectCatalog(join(root, 'projects.json'));

    await should(projects.register({ kind: 'existing-folder', path: join(root, 'absent') })).be.rejectedWith(
      'project path is not an existing directory',
    );
    should(await projects.projects()).deepEqual([]);
  });

  it('registers a folder without a Git attachment when Git cannot be started', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-nogit-'));
    const folder = join(root, 'project');
    await mkdir(folder);
    const projects = new FileProjectCatalog(join(root, 'projects.json'));
    // A host without `git` makes the spawn itself throw, which is not a non-zero exit.
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('Executable not found in $PATH: "git"');
    }) as unknown as typeof Bun.spawn);
    try {
      const registered = await projects.register({ kind: 'existing-folder', path: folder });
      should(registered.git).be.undefined();
      should(registered.path).equal(await realpath(folder));
    } finally {
      spawn.mockRestore();
    }
  });

  it('attaches the repository common directory for a folder that is a Git work tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-git-'));
    const folder = join(root, 'project');
    await mkdir(folder);
    const init = Bun.spawn(['git', 'init', '--quiet', folder], { stdout: 'pipe', stderr: 'pipe' });
    should(await init.exited).equal(0);
    const projects = new FileProjectCatalog(join(root, 'projects.json'));

    const registered = await projects.register({ kind: 'existing-folder', path: folder });

    should(registered.git).deepEqual({ commonDirectory: join(await realpath(folder), '.git') });
  });
});

describe('FileProjectCatalog registrations at once', () => {
  it('makes one record for two registrations of one repository and keeps every other one', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-race-'));
    const repository = join(root, 'repo');
    await mkdir(repository);
    const init = Bun.spawn(['git', 'init', '--quiet', repository], { stdout: 'pipe', stderr: 'pipe' });
    should(await init.exited).equal(0);
    const folders = await Promise.all(
      ['a', 'b', 'c'].map(async name => {
        const folder = join(root as string, name);
        await mkdir(folder);
        return folder;
      }),
    );
    const projects = new FileProjectCatalog(join(root, 'projects.json'));

    const registered = await Promise.all([
      projects.register({ kind: 'confirmed-discovery', path: repository }),
      projects.register({ kind: 'existing-folder', path: repository }),
      ...folders.map(path => projects.register({ kind: 'existing-folder', path })),
    ]);

    should(registered[0]?.id).equal(registered[1]?.id);
    should((await projects.projects()).map(project => project.name).sort()).deepEqual(['a', 'b', 'c', 'repo']);
  });
});
