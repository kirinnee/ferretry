/**
 * The seed-provenance document on a real filesystem.
 *
 * This is the file a daemon writes and a terminal reads, so the properties under test are the ones a
 * disagreement between those two would turn into a wrong claim about somebody's credential: what an
 * absent, damaged or foreign-versioned document reads as, that a replacement is atomic, and that the
 * bytes on disk are readable only by their owner.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileSeedProvenanceStore, seedProvenancePath } from '../../src/adapters/seed-provenance-store.ts';
import {
  type FleetSeedProvenanceRecord,
  SEED_PROVENANCE_FILE,
  SEED_PROVENANCE_VERSION,
} from '../../src/lib/seed-provenance.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const workspace = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-seed-provenance-'));
  directories.push(directory);
  return directory;
};

const record = (patch: Partial<FleetSeedProvenanceRecord> = {}): FleetSeedProvenanceRecord => ({
  accountId: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  seededFrom: 'host:claude',
  donorHome: '/home/me/.claude',
  seedFingerprint: 'a'.repeat(32),
  seededAt: 1_786_000_000_000,
  ...patch,
});

describe('seedProvenancePath', () => {
  it('puts the document beside the manifest, under the fleet directory', async () => {
    // Assert — never inside the manifest: an apply regenerates that file and this must survive one.
    should(seedProvenancePath('/state/fleet')).equal(`/state/fleet/${SEED_PROVENANCE_FILE}`);
  });
});

describe('FileSeedProvenanceStore', () => {
  it('round-trips the records it was handed', async () => {
    // Arrange
    const directory = await workspace();
    const subject = new FileSeedProvenanceStore(seedProvenancePath(directory));

    // Act
    await subject.write([record()]);

    // Assert
    should(await subject.read()).deepEqual([record()]);
  });

  it('reads a host that has never been seeded as no records', async () => {
    // Assert — an absent document is a fleet nobody seeded, which is what every surface says nothing
    // about. It is NOT an error, and it is NOT evidence that any account owns its credential.
    const directory = await workspace();
    should(await new FileSeedProvenanceStore(seedProvenancePath(directory)).read()).be.empty();
  });

  it('reads a damaged document as no records rather than refusing', async () => {
    // Arrange — a torn write, or a file somebody edited by hand.
    const directory = await workspace();
    const file = seedProvenancePath(directory);
    await writeFile(file, '{"version": 1, "accounts": [', 'utf8');

    // Assert — the cost is real and declared: the disclosure is gone and cannot be recomputed. The
    // alternative is a health report that refuses the question it was actually asked.
    should(await new FileSeedProvenanceStore(file).read()).be.empty();
  });

  it('reads a document from a version this build does not own as no records', async () => {
    // Arrange
    const directory = await workspace();
    const file = seedProvenancePath(directory);
    await writeFile(file, JSON.stringify({ version: 2, accounts: [record()] }), 'utf8');

    // Assert — recognised rather than guessed at. A future shape is not this build's to interpret.
    should(await new FileSeedProvenanceStore(file).read()).be.empty();
  });

  it('writes the version so a later build can recognise its own document', async () => {
    // Arrange
    const directory = await workspace();
    const file = seedProvenancePath(directory);

    // Act
    await new FileSeedProvenanceStore(file).write([record()]);

    // Assert
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    should((parsed as { version: number }).version).equal(SEED_PROVENANCE_VERSION);
  });

  it('replaces the document rather than appending to it', async () => {
    // Arrange
    const directory = await workspace();
    const subject = new FileSeedProvenanceStore(seedProvenancePath(directory));
    await subject.write([record({ seedFingerprint: 'b'.repeat(32) })]);

    // Act
    await subject.write([record({ seedFingerprint: 'c'.repeat(32) })]);

    // Assert — one row per account, and the newest digest. Two digests for one home would leave no
    // rule for which is current.
    const stored = await subject.read();
    should(stored).have.length(1);
    should(stored[0]?.seedFingerprint).equal('c'.repeat(32));
  });

  it('creates the fleet directory when a first write arrives before it exists', async () => {
    // Arrange — a host whose fleet directory has not been scaffolded yet.
    const directory = await workspace();
    const file = seedProvenancePath(path.join(directory, 'fleet'));

    // Act
    await new FileSeedProvenanceStore(file).write([record()]);

    // Assert
    should(await new FileSeedProvenanceStore(file).read()).have.length(1);
  });

  it('leaves the document readable only by its owner', async () => {
    // Arrange
    const directory = await workspace();
    const file = seedProvenancePath(directory);

    // Act
    await new FileSeedProvenanceStore(file).write([record()]);

    // Assert — it holds digests rather than material, and a digest is an equality token rather than
    // an oracle. Nothing else needs to read it either way.
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('narrows a document that already existed at a wider mode', async () => {
    // Arrange — a file left behind by an older build, or by a hand edit.
    const directory = await workspace();
    const file = seedProvenancePath(directory);
    await writeFile(file, '{}', { mode: 0o644 });

    // Act
    await new FileSeedProvenanceStore(file).write([record()]);

    // Assert
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('leaves the previous document in place when a write cannot land', async () => {
    // Arrange — the path is a directory, so both the temporary create and the rename fail.
    const directory = await workspace();
    const good = new FileSeedProvenanceStore(seedProvenancePath(directory));
    await good.write([record()]);
    const blocked = new FileSeedProvenanceStore(directory);

    // Act / Assert — a write failure PROPAGATES. A store that swallowed it would be
    // indistinguishable from one whose records never change.
    await should(blocked.write([record()])).be.rejected();
    should(await good.read()).have.length(1);
  });
});
