import { afterEach, beforeEach, describe, it } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('should persist an observed hierarchy entry before extending it', async () => {
    // Arrange
    const storeParent = dirname(root);
    const observedAncestor = dirname(storeParent);
    const expectedFirstSync = dirname(observedAncestor);
    let reportCreated!: () => void;
    let releaseCreator!: () => void;
    let reportFirstSync!: (path: string) => void;
    const ancestorCreated = new Promise<void>(resolve => {
      reportCreated = resolve;
    });
    const creatorReleased = new Promise<void>(resolve => {
      releaseCreator = resolve;
    });
    const firstObserverSync = new Promise<string>(resolve => {
      reportFirstSync = resolve;
    });
    const creator = store({
      uniqueId: () => 'hierarchy-creator',
      afterHierarchyCreate: async path => {
        if (path !== observedAncestor) return;
        reportCreated();
        await creatorReleased;
      },
    });
    const observer = store({
      uniqueId: () => 'hierarchy-observer',
      afterDirectorySync: async path => {
        reportFirstSync(path);
      },
    });

    // Act
    const creating = creator.build();
    await ancestorCreated;
    const observing = observer.build();
    const actualFirstSync = await firstObserverSync;
    const observerOutcome = await observing.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    releaseCreator();
    const created = await creating;
    if (!observerOutcome.ok) throw observerOutcome.error;

    // Assert
    should(actualFirstSync).equal(expectedFirstSync);
    should(observerOutcome.value.id).equal(created.id);
  });

  it('should persist an observed initialized root before reusing it', async () => {
    // Arrange
    const storeParent = dirname(root);
    const expectedObserverSyncs = [dirname(storeParent), root, storeParent];
    let reportRootSynced!: () => void;
    let releaseCreator!: () => void;
    let reportObserverSyncs!: () => void;
    const rootSynced = new Promise<void>(resolve => {
      reportRootSynced = resolve;
    });
    const creatorReleased = new Promise<void>(resolve => {
      releaseCreator = resolve;
    });
    const firstThreeObserverSyncs = new Promise<void>(resolve => {
      reportObserverSyncs = resolve;
    });
    let creatorPaused = false;
    const creator = store({
      uniqueId: () => 'root-creator',
      afterDirectorySync: async path => {
        if (path !== root || creatorPaused) return;
        creatorPaused = true;
        reportRootSynced();
        await creatorReleased;
      },
    });
    const observerSyncs: string[] = [];
    const observer = store({
      uniqueId: () => 'root-observer',
      afterDirectorySync: async path => {
        observerSyncs.push(path);
        if (observerSyncs.length === expectedObserverSyncs.length) reportObserverSyncs();
      },
    });

    // Act
    const creating = creator.build();
    await rootSynced;
    const observing = observer.build();
    await firstThreeObserverSyncs;
    const observerOutcome = await observing.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    releaseCreator();
    const created = await creating;
    if (!observerOutcome.ok) throw observerOutcome.error;

    // Assert
    should(observerSyncs.slice(0, expectedObserverSyncs.length)).deepEqual(expectedObserverSyncs);
    should(observerOutcome.value.id).equal(created.id);
  });

  it('should never replace a content address another builder is still publishing', async () => {
    // Arrange
    let reportClaim!: () => void;
    let releaseClaim!: () => void;
    const claimed = new Promise<void>(resolve => {
      reportClaim = resolve;
    });
    const released = new Promise<void>(resolve => {
      releaseClaim = resolve;
    });
    const first = store({
      uniqueId: () => 'builder-a',
      afterTargetClaim: async () => {
        reportClaim();
        await released;
      },
    });
    const second = store({ uniqueId: () => 'builder-b' });

    // Act
    const publishing = first.build();
    await claimed;
    try {
      await should(second.build()).be.rejectedWith(/mutable; snapshots must be read-only/u);
    } finally {
      releaseClaim();
    }
    const published = await publishing;
    const reused = await second.build();

    // Assert
    should(published.created).be.true();
    should(reused.created).be.false();
    should(reused.id).equal(published.id);
    should(await readFile(published.binaryPath, 'utf8')).equal('#!/bin/sh\necho first\n');
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

  it('should return the snapshot each concurrent promotion published even after it is superseded', async () => {
    // Arrange
    const subject = store();
    const first = await subject.build();
    await writeExecutable('#!/bin/sh\necho second\n');
    const second = await subject.build();
    let reportPublished!: () => void;
    let releasePublished!: () => void;
    const published = new Promise<void>(resolve => {
      reportPublished = resolve;
    });
    const released = new Promise<void>(resolve => {
      releasePublished = resolve;
    });
    const paused = store({
      afterPromotionPublish: async () => {
        reportPublished();
        await released;
      },
    });

    // Act
    const promotingFirst = paused.promote(first.id);
    await published;
    const promotedSecond = await subject.promote(second.id);
    releasePublished();
    const promotedFirst = await promotingFirst;

    // Assert
    should(promotedFirst.id).equal(first.id);
    should(promotedSecond.id).equal(second.id);
    should((await subject.current())?.id).equal(second.id);
  });

  it('should remember that promotion occurred and refuse to bootstrap over a lost current pointer', async () => {
    // Arrange
    const subject = store();
    const built = await subject.build();
    await subject.promote(built.id);
    await rm(join(root, 'current'));

    // Act + Assert
    await should(subject.current()).be.rejectedWith(/current is missing after this store was promoted/u);

    // An explicit promotion is the operator-controlled repair path; it never needs live source.
    should((await subject.promote(built.id)).id).equal(built.id);
    should((await subject.current())?.id).equal(built.id);
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

  it('should resolve live source only for builds, never inspection or rollback', async () => {
    // Arrange
    const available = store();
    const built = await available.build();
    await available.promote(built.id);
    let resolutions = 0;
    const unavailable = store({
      sourceBinary: () => {
        resolutions += 1;
        throw new Error('live fyd disappeared');
      },
    });

    // Act + Assert
    should((await unavailable.current())?.id).equal(built.id);
    should((await unavailable.list()).map(snapshot => snapshot.id)).deepEqual([built.id]);
    should((await unavailable.promote(built.id)).id).equal(built.id);
    should(resolutions).equal(0);
    await should(unavailable.build()).be.rejectedWith(/live fyd disappeared/u);
    should(resolutions).equal(1);
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

  it('should never overwrite a damaged empty content-addressed target', async () => {
    // Arrange
    const subject = store();
    const built = await subject.build();
    const target = join(built.binaryPath, '..');
    await chmod(target, 0o755);
    await rm(built.binaryPath);
    await rm(join(target, 'manifest.json'));
    await chmod(target, 0o555);

    // Act + Assert
    await should(subject.build()).be.rejectedWith(/not a complete two-file daemon snapshot/u);
    should(await readdir(target)).deepEqual([]);
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

  it('should accept a valid store reached through a symlinked ancestor', async () => {
    // Arrange
    const actualState = join(directory, 'actual-state');
    const linkedState = join(directory, 'linked-state');
    await mkdir(actualState);
    await symlink(actualState, linkedState);
    const subject = store({ root: join(linkedState, 'ferretry', 'daemon-snapshots', 'fyd') });

    // Act
    const built = await subject.build();
    const promoted = await subject.promote(built.id);

    // Assert
    should(promoted.id).equal(built.id);
    should(promoted.binaryPath).startWith(await realpath(actualState));
    should(promoted.binaryPath).not.startWith(linkedState);
    should(await readlink(join(linkedState, 'ferretry', 'daemon-snapshots', 'fyd', 'current'))).equal(
      `snapshots/${built.id}/fyd`,
    );
    should((await subject.current())?.id).equal(built.id);
  });

  it('should distinguish absent storage from a present but structurally incomplete store', async () => {
    // Arrange
    const subject = store();

    // Act + Assert
    should(await subject.list()).deepEqual([]);
    await mkdir(root, { recursive: true });
    await should(subject.list()).be.rejectedWith(/exists without its snapshots directory/u);

    await mkdir(join(root, 'snapshots'));
    await should(subject.current()).be.rejectedWith(/exists without its staging directory/u);
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

    await should(store({ sourceBinary: 'relative/fyd' }).build()).be.rejectedWith(/must be an absolute path/u);
    await should(store({ sourceBinary: '  ' }).build()).be.rejectedWith(/must not be empty/u);
  });

  it('should discard a build when its source changes during the copy', async () => {
    // Arrange
    const subject = store({ afterCopy: async () => await writeExecutable('#!/bin/sh\necho changed midway\n') });

    // Act + Assert
    await should(subject.build()).be.rejectedWith(/source changed while it was being copied/u);
    should(await subject.list()).deepEqual([]);
  });

  it('should reject a relative or filesystem-root store before touching disk', () => {
    // Act + Assert
    should(() => store({ root: 'relative' })).throw(/snapshot root must be a non-root absolute path/u);
    should(() => store({ root: '/' })).throw(/snapshot root must be a non-root absolute path/u);
  });

  /**
   * The cheap inventory the daemon lifecycle reconciles garbage-collection roots against.
   *
   * It answers a different question from `list()` and therefore makes different promises: it names
   * snapshots rather than proving them, and one entry it cannot trust becomes a sentence rather than a
   * throw. Both properties are load-bearing — a verifying, all-or-nothing listing on the critical path
   * of every mutating verb meant one interrupted build disabled the whole lifecycle surface, and
   * `restart` stopped the daemon before it discovered the problem.
   */
  describe('retained inventory', () => {
    /** What an interrupted build leaves: the address reserved, the files not yet moved in. */
    async function interruptedBuild(id: string): Promise<string> {
      // A real build creates the complete managed container before it reserves an address. Tests for
      // one bad entry must not accidentally be tests for a missing store-level staging directory.
      await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 });
      const path = join(root, 'snapshots', id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    }

    it('should name every retained snapshot and its source without proving any of them', async () => {
      // Arrange
      const subject = store();
      const first = await subject.build();
      await writeExecutable('#!/bin/sh\necho second\n');
      const second = await subject.build();

      // Act
      const inventory = await subject.retained();

      // Assert
      should(inventory.complete).be.true();
      should(inventory.unreadable).be.empty();
      should([...inventory.snapshots].sort((left, right) => left.id.localeCompare(right.id))).deepEqual(
        [
          { id: first.id, sourceBinary: source },
          { id: second.id, sourceBinary: source },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    });

    it('should not verify the executable, which is what makes it cheap enough to run every time', async () => {
      // Arrange — the same snapshot the verifying listing refuses, because reconciliation needs a
      // closure named, never an executable proven. Digesting every retained binary made `start` cost
      // more the longer a host had been building snapshots.
      const subject = store();
      const built = await subject.build();
      await makeWritable(join(built.binaryPath, '..'));
      await writeFile(built.binaryPath, '#!/bin/sh\necho tampered\n');
      await chmod(built.binaryPath, 0o555);
      await chmod(join(built.binaryPath, '..', 'manifest.json'), 0o444);
      await chmod(join(built.binaryPath, '..'), 0o555);

      // Act
      const inventory = await subject.retained();

      // Assert — and `list()`, the operator report, still refuses it.
      should(inventory.snapshots).deepEqual([{ id: built.id, sourceBinary: source }]);
      should(inventory.complete).be.true();
      await should(subject.list()).be.rejectedWith(/does not match its snapshot manifest/u);
    });

    it('should skip an interrupted build beside a healthy snapshot and say the set is incomplete', async () => {
      // Arrange — `build` reserves the content address before it moves its files in, and no later
      // build repairs what a kill in that window leaves. This is the entry that used to take the
      // whole lifecycle down.
      const subject = store();
      const healthy = await subject.build();
      const damaged = await interruptedBuild(`sha256-${'a'.repeat(64)}`);

      // Act
      const inventory = await subject.retained();

      // Assert — the healthy snapshot is still named, so its closure is still held.
      should(inventory.snapshots).deepEqual([{ id: healthy.id, sourceBinary: source }]);
      should(inventory.complete).be.false();
      should(inventory.unreadable).deepEqual([
        {
          path: damaged,
          reason: `could not be trusted: ${damaged} is mutable; snapshots must be read-only`,
        },
      ]);
      await should(subject.list()).be.rejectedWith(/is mutable/u);
    });

    it.each([
      { name: 'a manifest that is not JSON', contents: 'not json at all', expected: /cannot parse/u },
      {
        name: 'a manifest of a shape this store never wrote',
        contents: JSON.stringify({ version: 2, id: 'whatever' }),
        expected: /invalid daemon snapshot manifest/u,
      },
      {
        name: 'a manifest for a different snapshot',
        contents: JSON.stringify({
          version: 1,
          daemon: DAEMON,
          id: `sha256-${'c'.repeat(64)}`,
          digest: 'c'.repeat(64),
          bytes: 12,
          sourceBinary: '/opt/fy/bin/fyd',
          createdAt: '2026-08-04T12:00:00.000Z',
        }),
        expected: /does not identify snapshot/u,
      },
      {
        name: 'a digest that disagrees with its content address',
        contents: JSON.stringify({
          version: 1,
          daemon: DAEMON,
          id: `sha256-${'b'.repeat(64)}`,
          digest: 'c'.repeat(64),
          bytes: 12,
          sourceBinary: '/opt/fy/bin/fyd',
          createdAt: '2026-08-04T12:00:00.000Z',
        }),
        expected: /does not identify snapshot/u,
      },
      {
        name: 'a relative source executable',
        contents: JSON.stringify({
          version: 1,
          daemon: DAEMON,
          id: `sha256-${'b'.repeat(64)}`,
          digest: 'b'.repeat(64),
          bytes: 12,
          sourceBinary: 'relative/fyd',
          createdAt: '2026-08-04T12:00:00.000Z',
        }),
        expected: /does not identify snapshot/u,
      },
      { name: 'no manifest at all', contents: undefined, expected: /could not be trusted/u },
    ])('should skip an entry with $name', async ({ contents, expected }) => {
      // Arrange
      const id = `sha256-${'b'.repeat(64)}`;
      const path = await interruptedBuild(id);
      if (contents !== undefined) await writeFile(join(path, 'manifest.json'), contents, { mode: 0o444 });
      await chmod(path, 0o555);

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory.snapshots).be.empty();
      should(inventory.complete).be.false();
      should(inventory.unreadable[0]?.reason).match(expected);
    });

    it('should skip an entry whose name is not a content address, and a file among the directories', async () => {
      // Arrange
      await mkdir(join(root, 'snapshots'), { recursive: true, mode: 0o700 });
      await mkdir(join(root, 'staging'), { mode: 0o700 });
      await mkdir(join(root, 'snapshots', 'not-a-snapshot'), { mode: 0o555 });
      await writeFile(join(root, 'snapshots', `sha256-${'d'.repeat(64)}`), 'a file, not a snapshot');

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory.snapshots).be.empty();
      should(inventory.unreadable).have.length(2);
      should(
        inventory.unreadable.every(issue => issue.reason.includes('is not a daemon snapshot directory')),
      ).be.true();
    });

    it('should report a store that has never been built as complete and empty', async () => {
      // Arrange — the ordinary first-run state. Calling it incomplete would stop a fresh host from
      // ever releasing a root, and there is nothing there to be wrong about.
      await resetStore();

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory).deepEqual({ snapshots: [], complete: true, unreadable: [] });
    });

    it('should distrust a present store root whose snapshots child is missing', async () => {
      // Arrange — only an absent managed root is genuinely fresh. Once the root exists, missing
      // structure may be interrupted or damaged durable state and cannot authorize root release.
      await resetStore();
      await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 });

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory.snapshots).be.empty();
      should(inventory.complete).be.false();
      should(inventory.unreadable[0]?.reason).match(/exists without its snapshots directory/u);
    });

    it('should distrust a symlink standing where the managed snapshots directory belongs', async () => {
      // Arrange — following this link could make an unrelated empty directory look like a complete
      // empty inventory and release every root belonging to the real damaged store.
      await resetStore();
      const elsewhere = join(directory, 'unmanaged-snapshots');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(join(root, 'staging'), { mode: 0o700 });
      await mkdir(elsewhere, { mode: 0o700 });
      await symlink(elsewhere, join(root, 'snapshots'), 'dir');

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory.snapshots).be.empty();
      should(inventory.complete).be.false();
      should(inventory.unreadable[0]?.reason).match(/snapshots is not a real directory/u);
    });

    it('should report a store it cannot read at all as incomplete rather than throwing', async () => {
      // Arrange — a FILE where the snapshots directory belongs. Reconciliation is a safety net for a
      // rollback that might happen later; the daemon in front of the operator has to keep working.
      await resetStore();
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(join(root, 'snapshots'), 'not a directory');

      // Act
      const inventory = await store().retained();

      // Assert
      should(inventory.snapshots).be.empty();
      should(inventory.complete).be.false();
      should(inventory.unreadable[0]?.reason).match(/store structure could not be trusted/u);
    });
  });
});
