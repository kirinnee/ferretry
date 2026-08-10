import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
