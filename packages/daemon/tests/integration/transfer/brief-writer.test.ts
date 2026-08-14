import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import should from 'should';
import { FileSessionTransferBriefWriter } from '../../../src/adapters/transfer/brief-writer.ts';
import { type DurableArtifactIo, fsyncArtifactPath } from '../../../src/adapters/transfer/durable-artifact.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const TARGET = 'target-session';

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

function sessions(root: string): string {
  return join(root, 'state', 'sessions');
}

function turnsDirectory(root: string): string {
  return join(sessions(root), TARGET, 'turns');
}

function writer(root: string, io?: DurableArtifactIo): FileSessionTransferBriefWriter {
  return new FileSessionTransferBriefWriter(sessionId => join(sessions(root), sessionId), counter(), io);
}

interface DurabilityLedger {
  readonly events: string[];
  readonly io: DurableArtifactIo;
}

/**
 * Records every flush in order while still performing the REAL one.
 *
 * A stand-in recorder would make the durability assertions vacuous, so each hook calls through and
 * the optional callbacks are how a test inspects the filesystem — or simulates a power loss — at an
 * exact point in the publication sequence.
 */
function ledger(
  root: string,
  hooks: {
    readonly atDirectorySync?: (path: string) => Promise<void>;
    readonly atOpenFileSync?: () => Promise<void>;
  } = {},
): DurabilityLedger {
  const events: string[] = [];
  const name = (path: string): string => relative(root, path);
  return {
    events,
    io: {
      syncDirectory: async path => {
        events.push(`dir:${name(path)}`);
        await hooks.atDirectorySync?.(path);
        await fsyncArtifactPath(path);
      },
      syncOpenFile: async (handle, path) => {
        // A temporary being published, or an already-published file a replay proved from this handle.
        events.push(path.endsWith('.tmp') ? 'temp:fsync' : `file:${name(path)}`);
        await hooks.atOpenFileSync?.();
        await handle.sync();
      },
    },
  };
}

/**
 * The parent-first chain a target brief's publication always persists, from the STATE ROOT down.
 *
 * Not from the sessions root: the `<id>` entry inside it is flushed by the lifecycle reservation, but
 * the entry naming `<sessions>` itself is flushed by nobody — `StateFileSystem.ensureDirectory` is a
 * plain recursive `mkdir` — so it is an entry this publication must persist.
 */
function chain(): readonly string[] {
  return ['state', join('state', 'sessions'), join('state', 'sessions', TARGET)].map(path => `dir:${path}`);
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('FileSessionTransferBriefWriter', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('atomically writes turn one under only the explicit target key with private permissions', async () => {
    const root = await tempDirectory('transfer-brief-target');
    const subject = writer(root);
    const document = '# Frozen transfer brief\n';

    const file = await subject.write(TARGET, document);

    should(file).equal(join(root, 'state', 'sessions', TARGET, 'turns', 'turn-001.md'));
    should(await readFile(file, 'utf8')).equal(document);
    should((await stat(file)).mode & 0o777).equal(0o600);
    should((await stat(join(root, 'state', 'sessions', TARGET, 'turns'))).mode & 0o777).equal(0o700);
    should(await readdir(join(root, 'state', 'sessions'))).deepEqual([TARGET]);
    should(await readdir(join(root, 'state', 'sessions', TARGET, 'turns'))).deepEqual(['turn-001.md']);
  });

  it('is idempotent when replay supplies the same deterministic bytes', async () => {
    const root = await tempDirectory('transfer-brief-idempotent');
    const subject = writer(root);
    const document = '# Same persisted plan\n';
    const file = await subject.write(TARGET, document);
    const before = await stat(file);

    const replayed = await subject.write(TARGET, document);

    const after = await stat(file);
    should(replayed).equal(file);
    should(after.ino).equal(before.ino);
    should(after.mtimeMs).equal(before.mtimeMs);
  });

  it('atomically replaces a torn partial brief and leaves no temporary file', async () => {
    const root = await tempDirectory('transfer-brief-torn');
    const subject = writer(root);
    const file = subject.file(TARGET);
    await mkdir(join(root, 'state', 'sessions', TARGET, 'turns'), { recursive: true });
    await Bun.write(file, '# Frozen transfer');

    await subject.write(TARGET, '# Frozen transfer brief\n\nComplete.\n');

    should(await readFile(file, 'utf8')).equal('# Frozen transfer brief\n\nComplete.\n');
    should(await readdir(join(root, 'state', 'sessions', TARGET, 'turns'))).deepEqual(['turn-001.md']);
  });

  it('publishes in write, file fsync, close, rename, artifact-directory fsync order', async () => {
    // The receipt advances to `imported` the moment this returns, so the ORDER is the guarantee: the
    // temporary holds every byte before it is flushed, the final name does not exist until the
    // temporary is durable, and the directory that names it is flushed last.
    // Arrange
    const root = await tempDirectory('transfer-brief-order');
    const document = '# Ordered publication\n';
    const turns = turnsDirectory(root);
    const file = join(turns, 'turn-001.md');
    const observed: string[] = [];
    const recorder = ledger(root, {
      atOpenFileSync: async () => {
        const temporaries = (await readdir(turns)).filter(entry => entry.endsWith('.tmp'));
        should(temporaries).deepEqual(['turn-001.md.t1.tmp']);
        should(await readFile(join(turns, 'turn-001.md.t1.tmp'), 'utf8')).equal(document);
        // Flushed BEFORE it is published: the final name cannot exist yet.
        should(await readdir(turns)).not.containEql('turn-001.md');
        observed.push('every byte in the temporary, nothing published');
      },
      atDirectorySync: async path => {
        if (path !== turns) return;
        should(await readFile(file, 'utf8')).equal(document);
        // Renamed and closed: the temporary is gone before the name is persisted.
        should(await readdir(turns)).deepEqual(['turn-001.md']);
        observed.push('published, then the directory is flushed');
      },
    });

    // Act
    await writer(root, recorder.io).write(TARGET, document);

    // Assert — parents first, then the temporary's own flush, then the artifact directory, last.
    should(recorder.events).deepEqual([...chain(), 'temp:fsync', `dir:${join('state', 'sessions', TARGET, 'turns')}`]);
    should(observed).deepEqual([
      'every byte in the temporary, nothing published',
      'published, then the directory is flushed',
    ]);
  });

  it('persists created directory entries parent-first, and again for a writer that created none', async () => {
    // Arrange — `mkdir(recursive)` reports only what THIS call created, so an attempt standing in
    // front of a tree a concurrent attempt made would otherwise skip the very parent flushes its own
    // return depends on. The concurrent creator may crash before flushing anything, so the chain is
    // persisted unconditionally.
    const root = await tempDirectory('transfer-brief-parents');
    await mkdir(sessions(root), { recursive: true });
    const first = ledger(root);
    const second = ledger(root);

    // Act — a first creation, then a writer whose directories all already exist.
    await writer(root, first.io).write(TARGET, '# First attempt\n');
    await writer(root, second.io).write(TARGET, '# A later, different frozen document\n');

    // Assert — the same parent-first chain both times.
    const expected = [...chain(), 'temp:fsync', `dir:${join('state', 'sessions', TARGET, 'turns')}`];
    should(first.events).deepEqual(expected);
    should(second.events).deepEqual(expected);
  });

  it('never overwrites or removes a colliding writer temporary', async () => {
    // Arrange — a foreign attempt holds the exact temporary name this writer will mint.
    const root = await tempDirectory('transfer-brief-temp-collision');
    const turns = turnsDirectory(root);
    await mkdir(turns, { recursive: true });
    const foreign = join(turns, 'turn-001.md.t1.tmp');
    await Bun.write(foreign, '# another writer is mid-flight\n');

    // Act
    const error = await reject(writer(root).write(TARGET, '# Fresh brief\n'));

    // Assert — exclusive creation refused, foreign bytes intact, and nothing of ours cleaned up over it.
    should((error as { code?: string }).code).equal('EEXIST');
    should(await readFile(foreign, 'utf8')).equal('# another writer is mid-flight\n');
    should(await readdir(turns)).deepEqual(['turn-001.md.t1.tmp']);
  });

  it('re-establishes durability on a matching replay without replacing the inode or the bytes', async () => {
    // Arrange — a replay that reads the same bytes back has proved only that they are VISIBLE, which
    // is exactly what a page cache offers a moment before power is cut.
    const root = await tempDirectory('transfer-brief-replay-durability');
    const document = '# Same persisted plan\n';
    const file = await writer(root).write(TARGET, document);
    const before = await stat(file);
    const recorder = ledger(root);

    // Act
    const replayed = await writer(root, recorder.io).write(TARGET, document);

    // Assert — same inode and mtime, no temporary, and the chain plus the file itself flushed.
    const after = await stat(file);
    should(replayed).equal(file);
    should(after.ino).equal(before.ino);
    should(after.mtimeMs).equal(before.mtimeMs);
    should(recorder.events).deepEqual([
      // The proof and this flush share one read-only handle, so the inode vouched for is the inode
      // made durable; then the names it depends on are persisted.
      `file:${join('state', 'sessions', TARGET, 'turns', 'turn-001.md')}`,
      ...chain(),
      `dir:${join('state', 'sessions', TARGET, 'turns')}`,
    ]);
    should(await readdir(turnsDirectory(root))).deepEqual(['turn-001.md']);
  });

  it('proves an already-imported brief read-only, flushing and repairing nothing', async () => {
    // The fork's pre-launch check must REFUSE drift rather than repair it, so it may not touch the
    // medium at all — not even to flush what it read.
    // Arrange
    const root = await tempDirectory('transfer-brief-matches');
    const document = '# Frozen transfer brief\n';
    const recorder = ledger(root);
    const subject = writer(root, recorder.io);

    // Act + Assert — nothing written yet, then the exact document, then a drifted one.
    should(await subject.matches(TARGET, document)).be.false();
    await writer(root).write(TARGET, document);
    should(await subject.matches(TARGET, document)).be.true();
    should(await subject.matches(TARGET, '# A different document\n')).be.false();
    should(recorder.events).deepEqual([]);
  });

  it('reconstructs the exact brief from the frozen document after a loss before durability', async () => {
    // Arrange — power is cut inside the publication window: the rename was visible to this process,
    // but nothing had been flushed, so after the reboot neither the bytes nor the directory entry are
    // there. The frozen plan renders the same document, so a NEW writer replays it exactly.
    const root = await tempDirectory('transfer-brief-lost');
    const document = '# Frozen transfer brief\n\nOne cut, one document.\n';
    const turns = turnsDirectory(root);
    const lost = ledger(root, {
      atDirectorySync: async path => {
        if (path !== turns) return;
        await rm(join(turns, 'turn-001.md'));
        throw new Error('power was lost before the artifact directory was persisted');
      },
    });

    // Act — the interrupted attempt, then a fresh writer after the reboot.
    const error = await reject(writer(root, lost.io).write(TARGET, document));
    const recovered = await writer(root).write(TARGET, document);

    // Assert — the interrupted attempt did not return successfully, and nothing was left behind for
    // the replay to trip over.
    should((error as Error).message).containEql('power was lost');
    should(await readFile(recovered, 'utf8')).equal(document);
    should(await readdir(turns)).deepEqual(['turn-001.md']);
  });

  it('refuses an unusable target key before resolving a path', async () => {
    const root = await tempDirectory('transfer-brief-invalid');

    const error = await reject(writer(root).write('../source-session', 'never written'));

    should((error as Error).message).equal('target session id is not usable');
  });
});
