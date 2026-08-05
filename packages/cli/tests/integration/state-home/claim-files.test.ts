import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';

/** The real filesystem behind the claim: the one adapter that writes at the top of a state home. */

const roots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-claim-files-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('reading a state home from disk', () => {
  it('should answer undefined for a home that does not exist, not an empty one', async () => {
    // Arrange — the distinction decides whether the claim may create the directory, so collapsing
    // the two would let a claim proceed on a path that is really a typo.
    const root = await temporaryRoot();

    // Act + Assert
    should(await new FileStateHomeClaim().listHome(join(root, 'absent'))).be.undefined();
  });

  it('should list entries and say which are directories', async () => {
    // Arrange
    const root = await temporaryRoot();
    await mkdir(join(root, 'fleet'), { recursive: true });
    await writeFile(join(root, 'api-token'), 'secret\n', { mode: 0o600 });

    // Act
    const entries = await new FileStateHomeClaim().listHome(root);

    // Assert
    should([...(entries ?? [])].sort((a, b) => a.name.localeCompare(b.name))).deepEqual([
      { name: 'api-token', directory: false },
      { name: 'fleet', directory: true },
    ]);
  });

  it('should surface a failure that is not absence, rather than reading it as nothing there', async () => {
    // Arrange — a home the invoking user cannot read is a real problem. Reporting it as "empty"
    // would send the claim on to create a marker it cannot write, failing further from the cause.
    const root = await temporaryRoot();
    const home = join(root, 'locked');
    await mkdir(home, { recursive: true });
    await chmod(home, 0o000);

    // Act
    const failure = await new FileStateHomeClaim().listHome(home).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    await chmod(home, 0o700);
    should((failure as NodeJS.ErrnoException | undefined)?.code).equal('EACCES');
  });

  it('should answer undefined for an absent marker and the bytes for a present one', async () => {
    // Arrange
    const root = await temporaryRoot();
    const marker = join(root, 'layout-version');

    // Act + Assert
    should(await new FileStateHomeClaim().readMarker(marker)).be.undefined();
    await writeFile(marker, '1\n', 'utf8');
    should(await new FileStateHomeClaim().readMarker(marker)).equal('1\n');
  });

  it('should surface an unreadable marker rather than treating it as absent', async () => {
    // Arrange — an unreadable marker read as "no marker" would classify a claimed home as unclaimed.
    const root = await temporaryRoot();
    const marker = join(root, 'layout-version');
    await writeFile(marker, '1\n', 'utf8');
    await chmod(marker, 0o000);

    // Act
    const failure = await new FileStateHomeClaim().readMarker(marker).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((failure as NodeJS.ErrnoException | undefined)?.code).equal('EACCES');
  });
});

describe('creating and claiming a state home on disk', () => {
  it('should create the home and every missing parent with the mode it was given', async () => {
    // Arrange
    const root = await temporaryRoot();
    const home = join(root, 'nested', 'state');

    // Act
    await new FileStateHomeClaim().ensureDirectory(home, 0o700);

    // Assert
    should((await stat(home)).mode & 0o777).equal(0o700);
  });

  it('should accept a home that already exists', async () => {
    // Arrange — every write path calls the claim unconditionally, so this is the common case.
    const root = await temporaryRoot();

    // Act + Assert
    await should(new FileStateHomeClaim().ensureDirectory(root, 0o700)).be.fulfilled();
  });

  it('should write the marker with the exact bytes and the owner-only mode', async () => {
    // Arrange
    const root = await temporaryRoot();
    const marker = join(root, 'layout-version');

    // Act
    await new FileStateHomeClaim().writeMarkerAtomic(marker, '1\n', 0o600);

    // Assert — the mode is re-applied after the write because a permissive umask masks the one
    // `writeFile` is given, and an owner-only file that arrives as 0644 is not what was asked for.
    should(await readFile(marker, 'utf8')).equal('1\n');
    should((await stat(marker)).mode & 0o777).equal(0o600);
  });

  it('should leave no scratch file behind, so the home never reads as foreign afterwards', async () => {
    // Arrange — the claim writes through a temporary and renames; a stray `.tmp` at the top of a
    // home is an entry the daemon's layout model would have to classify.
    const root = await temporaryRoot();

    // Act
    await new FileStateHomeClaim().writeMarkerAtomic(join(root, 'layout-version'), '1\n', 0o600);

    // Assert
    should(await readdir(root)).deepEqual(['layout-version']);
  });

  it('should replace an existing marker rather than failing on it', async () => {
    // Arrange — a rename over an existing target is the atomicity this relies on.
    const root = await temporaryRoot();
    const marker = join(root, 'layout-version');
    await writeFile(marker, 'stale\n', 'utf8');

    // Act
    await new FileStateHomeClaim().writeMarkerAtomic(marker, '1\n', 0o600);

    // Assert
    should(await readFile(marker, 'utf8')).equal('1\n');
  });

  it('should clean up its scratch file when the write cannot complete', async () => {
    // Arrange — a failed claim must not leave debris in a directory it was refused from touching.
    const root = await temporaryRoot();
    const home = join(root, 'readonly');
    await mkdir(home, { recursive: true });
    await chmod(home, 0o500);

    // Act
    const failure = await new FileStateHomeClaim().writeMarkerAtomic(join(home, 'layout-version'), '1\n', 0o600).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    await chmod(home, 0o700);
    should(failure).be.instanceOf(Error);
    should(await readdir(home)).be.empty();
  });
});
