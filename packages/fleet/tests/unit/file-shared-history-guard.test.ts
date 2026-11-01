import { describe, it } from 'bun:test';
import should from 'should';
import { FileSharedHistoryFileSystem } from '../../src/adapters/file-shared-history.ts';
import { SharedHistoryMigration, type SharedHistoryRequest } from '../../src/lib/shared-history.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * The shared-history migration's file system asks the state-home guard for every folder it reads or changes. These
 * drive a whole migration over the guard's in-memory disk and make the guard answer each way it refuses — a migrated
 * folder that is a state home, one whose identity changed between two steps, one that cannot be reached through its
 * descriptor — and show the migration refuses, saying why, with nothing on the disk renamed, unlinked or removed.
 * The guard's own refusals on a real disk are proved by its tests (state-home-guard, descriptor-calls).
 */

const HOME = '/fy/fleet/homes/a';
const POOL = '/fy/fleet/shared';

/** A state home with its vault key, one Claude runtime holding a project transcript, and the pool's folder. */
const world = (reach: boolean | 'calls' = true) => {
  const disk = new FakeGuardDisk(reach);
  disk.dir('/fy');
  disk.dir('/fy/state');
  disk.file('/fy/state/secrets.key', 10, 'vault-key');
  disk.dir('/fy/config');
  disk.dir('/fy/fleet');
  disk.dir('/fy/fleet/homes');
  disk.dir(HOME);
  disk.dir(`${HOME}/projects`);
  disk.dir(`${HOME}/projects/project`);
  disk.file(`${HOME}/projects/project/session.jsonl`, 6, 'turns\n');
  disk.dir(POOL);
  const files = new FileSharedHistoryFileSystem(['/fy'], { homes: ['/fy', '/fy/state', '/fy/config'], open: [] }, disk);
  const migration = new SharedHistoryMigration(files);
  const request: SharedHistoryRequest = { kind: 'claude', poolRoot: POOL, homes: [{ account: 'a', path: HOME }] };
  return { disk, migration, request };
};

/** Every name on the disk and what it is, so a test can prove nothing was renamed, unlinked or removed. */
const layout = (disk: FakeGuardDisk): readonly string[] =>
  [...disk.entries].map(([name, entry]) => `${name}:${entry.kind}`).toSorted();

const refusalOf = async (attempt: Promise<unknown>): Promise<Error> => {
  const outcome = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error('expected the migration to be refused');
  return outcome;
};

describe('FileSharedHistoryFileSystem — every folder through the state-home guard', () => {
  it('should refuse a migrated folder the guard finds to be a state home, changing nothing', async () => {
    // Arrange — the runtime's projects folder is, by identity, the state folder (as a bind mount would make it).
    const { disk, migration, request } = world();
    disk.move(`${HOME}/projects`, `${HOME}/projects-was`);
    disk.bind(`${HOME}/projects`, '/fy/state');
    const before = layout(disk);

    // Act
    const refused = await refusalOf(migration.materialize(request));

    // Assert
    should(refused.message).match(/inside this daemon's state home/u);
    should(layout(disk)).deepEqual(before);
    should(disk.removed).deepEqual([]);
    should(disk.unlinked).deepEqual([]);
  });

  it('should refuse a migrated folder whose identity changed between the look and the open, changing nothing', async () => {
    // Arrange — between the guard describing the projects folder and opening it, its name comes to lead elsewhere.
    const { disk, migration, request } = world();
    disk.beforeOpen = path => {
      if (!path.endsWith('/projects')) return;
      disk.beforeOpen = undefined;
      disk.move(`${HOME}/projects`, `${HOME}/projects-was`);
      disk.link(`${HOME}/projects`, '/fy/state');
    };

    // Act
    const refused = await refusalOf(migration.materialize(request));

    // Assert — refused at the open; the state folder and the runtime's own tree are untouched.
    should(refused.message).match(/refusing to write in .*\/projects: the state-home guard refused it \(changed\)/u);
    should(disk.entries.get('/fy/state/secrets.key')).match({ kind: 'file', text: 'vault-key' });
    should(disk.entries.get(`${HOME}/projects-was/project/session.jsonl`)).match({ kind: 'file' });
    should(disk.removed).deepEqual([]);
    should(disk.unlinked).deepEqual([]);
  });

  it('should refuse the migration where its folders cannot be reached through their descriptors', async () => {
    // Arrange — a disk reached by path only, where a swap timed between a check and a step could redirect it.
    const { disk, migration, request } = world(false);
    const before = layout(disk);

    // Act
    const refused = await refusalOf(migration.materialize(request));

    // Assert
    should(refused.message).match(/cannot be reached through their descriptors here/u);
    should(layout(disk)).deepEqual(before);
  });

  it('should refuse a migrated folder the guard cannot place, rather than reading it as absent', async () => {
    // Arrange — a file where the runtime's folder must be, inside the home: the guard says it is not a folder.
    const { disk, migration } = world();
    disk.file('/fy/fleet/homes/b', 4, 'note');
    const before = layout(disk);

    // Act
    const refused = await refusalOf(
      migration.materialize({ kind: 'claude', poolRoot: POOL, homes: [{ account: 'b', path: '/fy/fleet/homes/b/x' }] }),
    );

    // Assert
    should(refused.message).match(/is not a folder|must be a directory/u);
    should(layout(disk)).deepEqual(before);
  });
});
