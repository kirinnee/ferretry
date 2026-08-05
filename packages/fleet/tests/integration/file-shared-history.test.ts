import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdtemp, open, readFile, readlink, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileSharedHistoryFileSystem } from '../../src/adapters/file-shared-history.ts';
import { type SharedHistoryFileSystem, SharedHistoryMigration } from '../../src/lib/shared-history.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-shared-history-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function write(target: string, content: string): Promise<void> {
  await Bun.write(target, content);
}

describe('FileSharedHistoryFileSystem', () => {
  it('should snapshot files, directories, and links without following a link', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const directory = path.join(root, 'directory');
    const file = path.join(directory, 'file.txt');
    const link = path.join(root, 'link');
    await write(file, 'evidence');
    await symlink('/outside/not-read', link);
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const tree = await subject.snapshot(directory);
    const text = await subject.snapshot(file, { readText: true });
    const symbolicLink = await subject.snapshot(link, { readText: true });
    const missing = await subject.snapshot(path.join(root, 'missing'));

    // Assert
    should(tree).match({ kind: 'directory', children: { 'file.txt': { kind: 'file', size: 8 } } });
    should(text).match({ kind: 'file', size: 8, text: 'evidence' });
    should(symbolicLink).match({ kind: 'symbolic-link', target: '/outside/not-read' });
    should(missing).be.undefined();
  });

  it('should create and preserve typed entries idempotently', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const directory = path.join(root, 'directory');
    const file = path.join(root, 'file');
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const createdDirectory = await subject.ensureDirectory(directory);
    const keptDirectory = await subject.ensureDirectory(directory);
    const createdFile = await subject.ensureFile(file);
    const keptFile = await subject.ensureFile(file);

    // Assert
    should(createdDirectory).be.true();
    should(keptDirectory).be.false();
    should(createdFile).be.true();
    should(keptFile).be.false();
    should((await lstat(directory)).isDirectory()).be.true();
    should((await lstat(file)).isFile()).be.true();
  });

  it('should move without replacing, atomically write text, and remove only the expected link', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const source = path.join(root, 'source');
    const destination = path.join(root, 'nested', 'destination');
    const link = path.join(root, 'link');
    await write(source, 'before');
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    await subject.move(source, destination);
    await subject.writeTextAtomic(destination, 'after');
    await subject.createSymbolicLink(destination, link);
    const linked = await readlink(link);
    await subject.removeSymbolicLink(link, destination);

    // Assert
    should(linked).equal(destination);
    should(await readFile(destination, 'utf8')).equal('after');
    should(await subject.snapshot(source)).be.undefined();
    should(await subject.snapshot(link)).be.undefined();
  });

  it('should remove only empty typed entries', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const directory = path.join(root, 'directory');
    const file = path.join(root, 'file');
    const subject = new FileSharedHistoryFileSystem([root]);
    await subject.ensureDirectory(directory);
    await subject.ensureFile(file);

    // Act
    await subject.removeEmptyDirectory(directory);
    await subject.removeFile(file);

    // Assert
    should(await subject.snapshot(directory)).be.undefined();
    should(await subject.snapshot(file)).be.undefined();
  });

  it('should refuse paths and mutations that would overwrite, dangle, or erase the wrong type', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    const directory = path.join(root, 'directory');
    const file = path.join(root, 'file');
    const otherFile = path.join(root, 'other');
    const link = path.join(root, 'link');
    const subject = new FileSharedHistoryFileSystem([root]);
    await subject.ensureDirectory(directory);
    await subject.ensureFile(file);
    await subject.ensureFile(otherFile);
    await subject.createSymbolicLink(file, link);

    // Act
    const actions = [
      async () => await subject.snapshot('relative'),
      async () => await subject.snapshot(outside),
      async () => await subject.ensureDirectory(file),
      async () => await subject.ensureFile(directory),
      async () => await subject.move(path.join(root, 'missing'), path.join(root, 'destination')),
      async () => await subject.move(file, otherFile),
      async () => await subject.writeTextAtomic(directory, 'bad'),
      async () => await subject.createSymbolicLink(path.join(root, 'missing'), path.join(root, 'dangling')),
      async () => await subject.createSymbolicLink(file, otherFile),
      async () => await subject.removeSymbolicLink(link, otherFile),
      async () => await subject.removeEmptyDirectory(file),
      async () => await subject.removeFile(directory),
    ];

    // Assert
    for (const action of actions) await should(action()).be.rejected();
    should(await readlink(link)).equal(file);
  });

  it('should fail closed when a directory cannot be listed', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const unreadable = path.join(root, 'unreadable');
    const child = path.join(unreadable, 'history');
    await write(child, 'evidence');
    await chmod(unreadable, 0o000);
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      const promise = subject.snapshot(unreadable);

      // Assert
      await should(promise).be.rejected();
    } finally {
      await chmod(unreadable, 0o700);
    }
  });

  it('should reject an empty allowed-root declaration', () => {
    // Act
    const act = () => new FileSharedHistoryFileSystem([]);

    // Assert
    should(act).throw(/at least one allowed shared-history root/);
  });
});

describe('shared-history migration with the real filesystem', () => {
  it('should preserve a live transcript inode while renaming its directory into the pool', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'claude-a');
    const transcript = path.join(home, 'projects', 'project', 'session.jsonl');
    const poolRoot = path.join(root, 'fleet', 'shared');
    await write(transcript, 'before\n');
    const openTranscript = await open(transcript, 'a');
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    try {
      // Act
      const actual = await subject.materialize({
        kind: 'claude',
        poolRoot,
        homes: [{ account: 'claude-a', path: home }],
      });
      await openTranscript.write('after\n');
      await openTranscript.sync();

      // Assert
      should(actual.migrated).equal(1);
      should((await lstat(path.join(home, 'projects'))).isSymbolicLink()).be.true();
      should(await readFile(path.join(poolRoot, 'claude', 'projects', 'project', 'session.jsonl'), 'utf8')).equal(
        'before\nafter\n',
      );
      should(await readFile(transcript, 'utf8')).equal('before\nafter\n');
    } finally {
      await openTranscript.close();
    }
  });

  it('should resolve collisions by mtime, preserve every loser, and merge prompt history', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const homeA = path.join(root, 'fleet', 'homes', 'a');
    const homeB = path.join(root, 'fleet', 'homes', 'b');
    const poolRoot = path.join(root, 'fleet', 'shared');
    const older = path.join(homeA, 'projects', 'project', 'same');
    const newer = path.join(homeB, 'projects', 'project', 'same');
    await write(older, 'older');
    await write(newer, 'newer');
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));
    await write(path.join(homeA, 'history.jsonl'), '{"display":"one","timestamp":1}\n');
    await write(
      path.join(homeB, 'history.jsonl'),
      '{"display":"two","timestamp":2}\n{"display":"one","timestamp":1}\n',
    );
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    // Act
    const preview = await subject.preview({
      kind: 'claude',
      poolRoot,
      homes: [
        { account: 'a', path: homeA },
        { account: 'b', path: homeB },
      ],
    });
    await subject.materialize({
      kind: 'claude',
      poolRoot,
      homes: [
        { account: 'a', path: homeA },
        { account: 'b', path: homeB },
      ],
    });

    // Assert
    should(preview.conflicts).equal(1);
    should(await readFile(path.join(poolRoot, 'claude', 'projects', 'project', 'same'), 'utf8')).equal('newer');
    should(
      await readFile(path.join(poolRoot, 'claude', '.migration-conflicts', 'b', 'projects', 'project', 'same'), 'utf8'),
    ).equal('older');
    should(await readFile(path.join(poolRoot, 'claude', 'history.jsonl'), 'utf8')).equal(
      '{"display":"one","timestamp":1}\n{"display":"two","timestamp":2}\n',
    );
  });

  it('should roll renamed history back when a later filesystem operation refuses', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'a');
    const projects = path.join(home, 'projects');
    const transcript = path.join(projects, 'session');
    const poolRoot = path.join(root, 'fleet', 'shared');
    await write(transcript, 'evidence');
    const real = new FileSharedHistoryFileSystem([root]);
    const failing: SharedHistoryFileSystem = {
      snapshot: async (target, options) => await real.snapshot(target, options),
      ensureDirectory: async target => await real.ensureDirectory(target),
      ensureFile: async target => await real.ensureFile(target),
      move: async (source, destination) => await real.move(source, destination),
      writeTextAtomic: async (target, text) => await real.writeTextAtomic(target, text),
      createSymbolicLink: async (target, destination) => {
        if (destination === path.join(home, 'sessions')) throw new Error('injected link failure');
        await real.createSymbolicLink(target, destination);
      },
      removeSymbolicLink: async (target, expected) => await real.removeSymbolicLink(target, expected),
      removeEmptyDirectory: async target => await real.removeEmptyDirectory(target),
      removeFile: async target => await real.removeFile(target),
    };
    const subject = new SharedHistoryMigration(failing);

    // Act
    const promise = subject.materialize({
      kind: 'claude',
      poolRoot,
      homes: [{ account: 'a', path: home }],
    });

    // Assert
    await should(promise).be.rejectedWith(/injected link failure/);
    should((await lstat(projects)).isDirectory()).be.true();
    should(await readFile(transcript, 'utf8')).equal('evidence');
  });
});
