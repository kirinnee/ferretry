import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileSharedHistoryFileSystem, sharedHistoryMoveRefusal } from '../../src/adapters/file-shared-history.ts';
import { SharedHistoryMigration } from '../../src/lib/shared-history.ts';

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

/** The real filesystem with one link refused, so rollback is proved against real state. */
class LinkFailingFileSystem extends FileSharedHistoryFileSystem {
  constructor(
    allowedRoots: readonly string[],
    private readonly refusedDestination: string,
  ) {
    super(allowedRoots);
  }

  override async createSymbolicLink(target: string, destination: string): Promise<void> {
    if (destination === this.refusedDestination) throw new Error('injected link failure');
    await super.createSymbolicLink(target, destination);
  }
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

  it('should refuse every operation whose ancestor link points out of the allowed roots', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const inside = path.join(root, 'inside');
    const escapeLink = path.join(root, 'escape');
    await write(path.join(outside, 'file'), 'foreign');
    await mkdir(path.join(outside, 'directory'));
    await symlink(path.join(outside, 'directory'), path.join(outside, 'link'));
    await write(inside, 'local');
    await symlink(outside, escapeLink);
    const subject = new FileSharedHistoryFileSystem([root]);
    const escaped = (name: string): string => path.join(escapeLink, name);

    // Act
    const actions = [
      async () => await subject.snapshot(escaped('file')),
      async () => await subject.ensureDirectory(escaped('created')),
      async () => await subject.ensureFile(escaped('created')),
      async () => await subject.move(inside, escaped('moved')),
      async () => await subject.move(escaped('file'), path.join(root, 'stolen')),
      async () => await subject.writeTextAtomic(escaped('file'), 'overwritten'),
      async () => await subject.writeTextExclusive(escaped('created'), 'overwritten'),
      async () => await subject.rewriteTextInPlace(escaped('file'), 'foreign', 'overwritten'),
      async () => await subject.createSymbolicLink(inside, escaped('created')),
      async () => await subject.createSymbolicLink(escaped('file'), path.join(root, 'stolen')),
      async () => await subject.removeSymbolicLink(escaped('link'), escaped('directory')),
      async () => await subject.removeEmptyDirectory(escaped('directory')),
      async () => await subject.removeFile(escaped('file')),
    ];

    // Assert
    for (const action of actions) await should(action()).be.rejectedWith(/outside configured roots/);
    should((await readdir(outside)).toSorted()).eql(['directory', 'file', 'link']);
    should(await readFile(path.join(outside, 'file'), 'utf8')).equal('foreign');
    should(await readFile(inside, 'utf8')).equal('local');
    should(await readdir(root)).not.containEql('stolen');
  });

  it('should accept a root reached through a link and still confine what is inside it', async () => {
    // Arrange
    const real = await temporaryDirectory();
    const elsewhere = await temporaryDirectory();
    const linkedRoot = path.join(elsewhere, 'root-link');
    await symlink(real, linkedRoot);
    const subject = new FileSharedHistoryFileSystem([linkedRoot]);

    // Act
    const created = await subject.ensureFile(path.join(linkedRoot, 'file'));
    const throughRealPath = await subject.snapshot(path.join(real, 'file'));

    // Assert
    should(created).be.true();
    should(throughRealPath).match({ kind: 'file' });
    await should(subject.snapshot(path.join(elsewhere, 'sibling'))).be.rejectedWith(/outside configured roots/);
  });

  it('should refuse the filesystem root and a path directly beneath it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const actions = [
      async () => await subject.snapshot(path.sep),
      async () => await subject.snapshot(path.join(path.sep, 'fy-shared-history-absent')),
    ];

    // Assert
    for (const action of actions) await should(action()).be.rejectedWith(/outside configured roots/);
  });

  it('should fail closed when an ancestor is a file or cannot be resolved', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const file = path.join(root, 'file');
    const unreadable = path.join(root, 'unreadable');
    await write(file, 'evidence');
    await write(path.join(unreadable, 'child'), 'evidence');
    await chmod(unreadable, 0o000);
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      const throughFile = async () => await subject.snapshot(path.join(file, 'a', 'b'));
      const throughUnreadable = async () => await subject.snapshot(path.join(unreadable, 'child', 'deeper'));

      // Assert
      await should(throughFile()).be.rejectedWith(/ENOTDIR/);
      await should(throughUnreadable()).be.rejectedWith(/EACCES/);
    } finally {
      await chmod(unreadable, 0o700);
    }
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

  it('should rewrite text in place, keeping the inode a live reader already holds', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const target = path.join(root, 'history.jsonl');
    await write(target, 'first\nsecond\n');
    const inodeBefore = (await lstat(target)).ino;
    const reader = await open(target, 'r');
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      const rewritten = await subject.rewriteTextInPlace(target, 'first\nsecond\n', 'only\n');
      const stale = await subject.rewriteTextInPlace(target, 'first\nsecond\n', 'never written\n');

      // Assert
      should(rewritten).be.true();
      should(stale).be.false();
      should((await lstat(target)).ino).equal(inodeBefore);
      should(await readFile(target, 'utf8')).equal('only\n');
      should(await reader.readFile('utf8')).equal('only\n');
    } finally {
      await reader.close();
    }
  });

  it('should refuse to rewrite anything that is not a regular file in place', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const file = path.join(root, 'file');
    const link = path.join(root, 'link');
    const directory = path.join(root, 'directory');
    await write(file, 'evidence');
    await symlink(file, link);
    await mkdir(directory);
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const actions = [link, directory, path.join(root, 'missing')].map(
      target => async () => await subject.rewriteTextInPlace(target, 'evidence', 'overwritten'),
    );

    // Assert
    for (const action of actions) await should(action()).be.rejectedWith(/in-place rewrite expected a file/);
    should(await readFile(file, 'utf8')).equal('evidence');
  });

  it('should write a journal entry exclusively and refuse to replace one', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const target = path.join(root, 'journal', 'entry.json');
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    await subject.writeTextExclusive(target, '{"step":1}\n');
    const replaced = subject.writeTextExclusive(target, '{"step":2}\n');

    // Assert
    await should(replaced).be.rejectedWith(/exclusive write refused an existing path/);
    should(await readFile(target, 'utf8')).equal('{"step":1}\n');
    should((await lstat(target)).mode & 0o777).equal(0o600);
  });

  it('should surface an exclusive-write failure that is not a collision', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const readOnly = path.join(root, 'read-only');
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      const promise = subject.writeTextExclusive(path.join(readOnly, 'entry.json'), '{"step":1}\n');

      // Assert
      await should(promise).be.rejectedWith(/EACCES/);
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  it('should surface a rename failure that is not a cross-device move unchanged', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const directory = path.join(root, 'directory');
    await mkdir(directory);
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const promise = subject.move(directory, path.join(directory, 'inside'));

    // Assert
    await should(promise).be.rejectedWith(/EINVAL/);
  });

  it('should refuse a cross-device move instead of copying pooled history', () => {
    // Act
    const refused = sharedHistoryMoveRefusal({ code: 'EXDEV' }, '/pool/source', '/other/destination');
    const passedThrough = sharedHistoryMoveRefusal({ code: 'EINVAL' }, '/pool/source', '/other/destination');

    // Assert
    should(refused).be.instanceof(Error);
    should((refused as Error).message).match(/refusing to copy shared history across filesystems/);
    should((refused as Error).message).match(/\/pool\/source -> \/other\/destination/);
    should(passedThrough).eql({ code: 'EINVAL' });
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
    const subject = new SharedHistoryMigration(new LinkFailingFileSystem([root], path.join(home, 'sessions')));

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
