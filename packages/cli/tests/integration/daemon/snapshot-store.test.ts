import { afterEach, beforeEach, describe, it } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  DaemonSnapshotStoreError,
  FileDaemonSnapshotStore,
  type FileDaemonSnapshotStoreOptions,
} from '../../../src/adapters/daemon/snapshot-store.ts';

const DAEMON = { product: 'ferretry', name: 'fyd' } as const;

describe('file daemon snapshot store', () => {
  let directory = '';
  let source = '';
  let root = '';
  let serial = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy-daemon-snapshots-'));
    source = join(directory, 'source-fyd');
    root = join(directory, 'state', 'ferretry', 'daemon-snapshots', 'fyd');
    serial = 0;
    await writeExecutable('#!/bin/sh\necho first\n');
  });

  afterEach(async () => {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  });

  function store(overrides: Partial<FileDaemonSnapshotStoreOptions> = {}): FileDaemonSnapshotStore {
    return new FileDaemonSnapshotStore({
      root,
      daemon: DAEMON,
      sourceBinary: source,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      uniqueId: () => {
        serial += 1;
        return `attempt-${String(serial)}`;
      },
      ...overrides,
    });
  }

  async function writeExecutable(contents: string): Promise<void> {
    await writeFile(source, contents, { mode: 0o755 });
    await chmod(source, 0o755);
  }

  async function makeWritable(path: string): Promise<void> {
    const state = await lstat(path).catch(() => undefined);
    if (state === undefined || state.isSymbolicLink()) return;
    await chmod(path, state.isDirectory() ? 0o700 : 0o600);
    if (!state.isDirectory()) return;
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  }

  async function resetStore(): Promise<void> {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }

  it('should build a complete content-addressed read-only snapshot without promoting it', async () => {
    // Arrange
    const subject = store();

    // Act
    const before = await subject.current();
    const built = await subject.build();

    // Assert
    should(before).be.undefined();
    should(built.created).be.true();
    should(built.id).match(/^sha256-[0-9a-f]{64}$/u);
    should(built.daemon).deepEqual(DAEMON);
    should(built.sourceBinary).equal(source);
    should(await readFile(built.binaryPath, 'utf8')).equal('#!/bin/sh\necho first\n');
    should((await stat(built.binaryPath)).mode & 0o777).equal(0o555);
    should((await stat(join(built.binaryPath, '..'))).mode & 0o777).equal(0o555);
    should(await subject.current()).be.undefined();
  });

  it('should reuse an identical verified snapshot rather than mutating it', async () => {
    // Arrange
    const subject = store();
    const first = await subject.build();
    const firstManifest = await readFile(join(first.binaryPath, '..', 'manifest.json'), 'utf8');

    // Act
    const second = await subject.build();

    // Assert
    should(second.id).equal(first.id);
    should(second.created).be.false();
    should(await readFile(join(second.binaryPath, '..', 'manifest.json'), 'utf8')).equal(firstManifest);
  });

  it('should promote and roll back only by atomic pointer replacement', async () => {
    // Arrange
    const subject = store();
    const first = await subject.build();
    await writeExecutable('#!/bin/sh\necho second\n');
    const second = await subject.build();

    // Act
    const promotedSecond = await subject.promote(second.id);
    const promotedFirst = await subject.promote(first.id);

    // Assert
    should(promotedSecond.id).equal(second.id);
    should(promotedFirst.id).equal(first.id);
    should((await subject.current())?.id).equal(first.id);
    should(await readlink(join(root, 'current'))).equal(`snapshots/${first.id}/fyd`);
    should(await readFile(first.binaryPath, 'utf8')).equal('#!/bin/sh\necho first\n');
    should(await readFile(second.binaryPath, 'utf8')).equal('#!/bin/sh\necho second\n');
  });

  it('should list every verified snapshot newest first', async () => {
    // Arrange
    const subject = store();
    const first = await subject.build();
    await writeExecutable('#!/bin/sh\necho second\n');
    const later = store({ now: () => new Date('2026-08-04T12:00:01.000Z') });
    const second = await later.build();

    // Act
    const actual = await later.list();

    // Assert
    should(actual.map(snapshot => snapshot.id)).deepEqual([second.id, first.id]);
  });

  it('should keep daemon namespaces disjoint even when their executable bytes match', async () => {
    // Arrange
    const first = store();
    const otherRoot = join(directory, 'state', 'ferretry', 'daemon-snapshots', 'otherd');
    const second = store({ root: otherRoot, daemon: { product: 'ferretry', name: 'otherd' } });

    // Act
    const firstSnapshot = await first.build();
    const secondSnapshot = await second.build();
    await first.promote(firstSnapshot.id);

    // Assert
    should(firstSnapshot.id).equal(secondSnapshot.id);
    should(firstSnapshot.binaryPath).not.equal(secondSnapshot.binaryPath);
    should(await second.current()).be.undefined();
  });

  it('should refuse a digest mismatch instead of promoting damaged bytes', async () => {
    // Arrange
    const subject = store();
    const built = await subject.build();
    await chmod(built.binaryPath, 0o755);
    await writeFile(built.binaryPath, '#!/bin/sh\necho planted\n');
    await chmod(built.binaryPath, 0o555);

    // Act + Assert
    await should(subject.promote(built.id)).be.rejectedWith(/does not match its snapshot manifest/u);
    should(await subject.current()).be.undefined();
  });

  it('should refuse malformed, cross-daemon and mutable manifests', async () => {
    // Arrange
    const malformedStore = store();
    const malformed = await malformedStore.build();
    const malformedManifest = join(malformed.binaryPath, '..', 'manifest.json');
    await chmod(malformedManifest, 0o644);
    await writeFile(malformedManifest, '{broken');
    await chmod(malformedManifest, 0o444);

    // Act + Assert
    await should(malformedStore.promote(malformed.id)).be.rejectedWith(/cannot parse/u);

    // Arrange
    await resetStore();
    const foreignStore = store();
    const foreign = await foreignStore.build();
    const foreignManifest = join(foreign.binaryPath, '..', 'manifest.json');
    const document = JSON.parse(await readFile(foreignManifest, 'utf8')) as { daemon: { name: string } };
    document.daemon.name = 'otherd';
    await chmod(foreignManifest, 0o644);
    await writeFile(foreignManifest, `${JSON.stringify(document)}\n`);
    await chmod(foreignManifest, 0o444);
    await should(foreignStore.promote(foreign.id)).be.rejectedWith(/different daemon/u);

    // Arrange
    await resetStore();
    const mutableStore = store();
    const mutable = await mutableStore.build();
    const mutableManifest = join(mutable.binaryPath, '..', 'manifest.json');
    await chmod(mutableManifest, 0o644);
    await should(mutableStore.promote(mutable.id)).be.rejectedWith(/mutable; snapshots must be read-only/u);
  });

  it('should refuse incomplete snapshots and unexpected store entries', async () => {
    // Arrange
    const subject = store();
    const built = await subject.build();
    const snapshotDirectory = join(built.binaryPath, '..');
    await chmod(snapshotDirectory, 0o755);
    await writeFile(join(snapshotDirectory, 'partial.tmp'), 'unfinished');
    await chmod(snapshotDirectory, 0o555);

    // Act + Assert
    await should(subject.promote(built.id)).be.rejectedWith(/not a complete two-file daemon snapshot/u);

    // Arrange
    await chmod(snapshotDirectory, 0o755);
    await rm(join(snapshotDirectory, 'partial.tmp'));
    await chmod(snapshotDirectory, 0o555);
    await mkdir(join(root, 'snapshots', 'not-a-snapshot'));
    await should(subject.list()).be.rejectedWith(/invalid snapshot entry/u);
  });

  it('should treat a dangling or malformed current pointer as damaged, never absent', async () => {
    // Arrange
    const danglingStore = store();
    const built = await danglingStore.build();
    await danglingStore.promote(built.id);
    await rename(join(built.binaryPath, '..'), join(root, 'snapshots', '.lost'));

    // Act + Assert
    await should(danglingStore.current()).be.rejectedWith(/refers to a missing snapshot/u);

    // Arrange
    await resetStore();
    const malformedStore = store();
    await malformedStore.build();
    await symlink('../outside', join(root, 'current'));
    await should(malformedStore.current()).be.rejectedWith(/invalid daemon snapshot target/u);

    // Arrange
    await rm(join(root, 'current'));
    await writeFile(join(root, 'current'), 'not a pointer');
    await should(malformedStore.current()).be.rejectedWith(/not an atomic snapshot symlink/u);
  });

  it('should reject invalid ids and a snapshot root redirected through a symlink', async () => {
    // Arrange
    const subject = store();

    // Act + Assert
    await should(subject.promote('../other')).be.rejectedWith(DaemonSnapshotStoreError);
    await should(subject.promote('sha256-deadbeef')).be.rejectedWith(/invalid fyd snapshot id/u);

    // Arrange
    const redirected = join(directory, 'redirected');
    await mkdir(redirected);
    await mkdir(join(directory, 'state', 'ferretry', 'daemon-snapshots'), { recursive: true });
    await symlink(redirected, root);
    await should(store().build()).be.rejectedWith(/is not a real directory/u);
  });

  it('should distinguish absent storage from a present but structurally incomplete store', async () => {
    // Arrange
    const subject = store();

    // Act + Assert
    should(await subject.list()).deepEqual([]);
    await mkdir(root, { recursive: true });
    await should(subject.list()).be.rejectedWith(/exists without its snapshots directory/u);
  });

  it('should reject missing, non-file, empty and non-executable sources', async () => {
    // Arrange + Act + Assert
    await rm(source);
    await should(store().build()).be.rejectedWith(/cannot resolve daemon snapshot source/u);

    await mkdir(source);
    await should(store().build()).be.rejectedWith(/not a regular file/u);

    await rm(source, { recursive: true });
    await writeFile(source, '', { mode: 0o755 });
    await should(store().build()).be.rejectedWith(/snapshot source is empty/u);

    await writeFile(source, '#!/bin/sh\n', { mode: 0o644 });
    await chmod(source, 0o644);
    await should(store().build()).be.rejectedWith(/snapshot source is not executable/u);
  });

  it('should reject a relative or filesystem-root store before touching disk', () => {
    // Act + Assert
    should(() => store({ root: 'relative' })).throw(/snapshot root must be a non-root absolute path/u);
    should(() => store({ root: '/' })).throw(/snapshot root must be a non-root absolute path/u);
  });
});
