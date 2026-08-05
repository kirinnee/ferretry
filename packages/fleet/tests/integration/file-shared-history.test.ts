import { afterEach, describe, it } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileSharedHistoryFileSystem, sharedHistoryMoveRefusal } from '../../src/adapters/file-shared-history.ts';
import { SharedHistoryMigration, type SharedHistoryRequest } from '../../src/lib/shared-history.ts';

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
    await subject.ensureDirectory(directory);
    await subject.ensureFile(file);
    await write(file, 'kept');
    await subject.ensureDirectory(directory);
    await subject.ensureFile(file);

    // Assert — a second call keeps what is there rather than replacing it.
    should((await lstat(directory)).isDirectory()).be.true();
    should(await readFile(file, 'utf8')).equal('kept');
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
      async () => await subject.appendTextIfPrefix(escaped('file'), 'foreign', 'overwritten'),
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
    await subject.ensureFile(path.join(linkedRoot, 'file'));
    const throughRealPath = await subject.snapshot(path.join(real, 'file'));

    // Assert
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

  it('should append in place, keeping the inode a live reader already holds', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const target = path.join(root, 'history.jsonl');
    await write(target, 'first\n');
    const inodeBefore = (await lstat(target)).ino;
    const reader = await open(target, 'r');
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      const appended = await subject.appendTextIfPrefix(target, 'first\n', 'second\n');
      const empty = await subject.appendTextIfPrefix(target, 'first\nsecond\n', '');
      const stale = await subject.appendTextIfPrefix(target, 'a different beginning\n', 'never written\n');

      // Assert
      should(appended).be.true();
      should(empty).be.true();
      should(stale).be.false();
      should((await lstat(target)).ino).equal(inodeBefore);
      should(await readFile(target, 'utf8')).equal('first\nsecond\n');
      should(await reader.readFile('utf8')).equal('first\nsecond\n');
    } finally {
      await reader.close();
    }
  });

  it('should never erase what a concurrent writer appended between the check and the write', async () => {
    // Arrange — the pooled history is live, so the only safe write is one that cannot truncate.
    const root = await temporaryDirectory();
    const target = path.join(root, 'history.jsonl');
    await write(target, '{"display":"pooled","timestamp":1}\n');
    const harness = await open(target, 'a');
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act — a foreign appender grows the file after the plan observed it.
      await harness.write('{"display":"live","timestamp":2}\n');
      await harness.sync();
      const appended = await subject.appendTextIfPrefix(
        target,
        '{"display":"pooled","timestamp":1}\n',
        '{"display":"migrated","timestamp":3}\n',
      );

      // Assert — growth past the observed prefix is tolerated and the live line is still there.
      should(appended).be.true();
      should(await readFile(target, 'utf8')).equal(
        '{"display":"pooled","timestamp":1}\n{"display":"live","timestamp":2}\n{"display":"migrated","timestamp":3}\n',
      );
    } finally {
      await harness.close();
    }
  });

  it('should refuse to append to anything that is not a regular file', async () => {
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
      target => async () => await subject.appendTextIfPrefix(target, 'evidence', 'appended'),
    );

    // Assert
    for (const action of actions) await should(action()).be.rejectedWith(/append expected a file/);
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
    const collided = sharedHistoryMoveRefusal({ code: 'EEXIST' }, '/pool/source', '/other/destination');
    const passedThrough = sharedHistoryMoveRefusal({ code: 'EINVAL' }, '/pool/source', '/other/destination');

    // Assert
    should(refused).be.instanceof(Error);
    should((refused as Error).message).match(/refusing to copy shared history across filesystems/);
    should((refused as Error).message).match(/\/pool\/source -> \/other\/destination/);
    // The kernel's own no-clobber refusal is phrased like the observation that precedes it, so a
    // caller cannot tell whether the collision was seen a moment early or refused atomically.
    should((collided as Error).message).equal('shared-history move destination already exists: /other/destination');
    should(passedThrough).eql({ code: 'EINVAL' });
  });

  it('should report the device a rename would land on, existing or not yet created', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    const file = path.join(root, 'file');
    await write(file, 'evidence');
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const existing = await subject.deviceIdOf(file);
    const missingPool = await subject.deviceIdOf(path.join(root, 'fleet', 'shared', 'claude'));

    // Assert — an absent pool answers with the device of the ancestor that will hold it.
    should(existing).equal((await lstat(file)).dev);
    should(missingPool).equal((await lstat(root)).dev);
    await should(subject.deviceIdOf(outside)).be.rejectedWith(/outside configured roots/);
  });

  it('should answer with one canonical directory however a path spells it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await mkdir(path.join(real, 'a'), { recursive: true });
    await symlink(real, alias);
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const throughReal = await subject.canonicalDirectoryOf(path.join(real, 'a'));
    const throughAlias = await subject.canonicalDirectoryOf(path.join(alias, 'a'));
    const notYetThere = await subject.canonicalDirectoryOf(path.join(alias, 'a', 'fleet', 'shared'));

    // Assert — the alias, the final link and the missing tail all reduce to the same real directory.
    should(throughAlias).equal(throughReal);
    should(throughAlias).equal(await realpath(path.join(real, 'a')));
    should(notYetThere).equal(path.join(throughReal, 'fleet', 'shared'));
  });

  it('should refuse to canonicalize a path whose own link leaves the allowed roots', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const elsewhere = await temporaryDirectory();
    const escapeLink = path.join(root, 'escape');
    await symlink(elsewhere, escapeLink);
    const subject = new FileSharedHistoryFileSystem([root]);

    // Act
    const promise = subject.canonicalDirectoryOf(escapeLink);

    // Assert
    await should(promise).be.rejectedWith(/outside configured roots/);
  });

  it('should move a regular file by hard link, keeping its inode and refusing to clobber', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const source = path.join(root, 'source.jsonl');
    const destination = path.join(root, 'pool', 'destination.jsonl');
    const occupied = path.join(root, 'pool', 'occupied.jsonl');
    await write(source, 'evidence\n');
    await write(occupied, 'do not lose me\n');
    const inodeBefore = (await lstat(source)).ino;
    const reader = await open(source, 'r');
    const subject = new FileSharedHistoryFileSystem([root]);

    try {
      // Act
      await subject.move(source, destination);
      const second = path.join(root, 'second.jsonl');
      await write(second, 'other\n');

      // Assert — the same inode is now at the new name and the old one is gone.
      should((await lstat(destination)).ino).equal(inodeBefore);
      should(await readFile(destination, 'utf8')).equal('evidence\n');
      should(await reader.readFile('utf8')).equal('evidence\n');
      should(await subject.snapshot(source)).be.undefined();
      // An occupied destination is refused, and the file that was there is untouched.
      await should(subject.move(second, occupied)).be.rejectedWith(/move destination already exists/);
      should(await readFile(occupied, 'utf8')).equal('do not lose me\n');
    } finally {
      await reader.close();
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
    should(preview.emptiedSourceDirectories).deepEqual([
      path.join(homeB, 'projects', 'project'),
      path.join(homeB, 'projects'),
    ]);
    should(await readFile(path.join(poolRoot, 'claude', 'projects', 'project', 'same'), 'utf8')).equal('newer');
    // The pooled loser is account a's file, so it is quarantined under a, not under the incoming b.
    should(
      await readFile(path.join(poolRoot, 'claude', '.migration-conflicts', 'a', 'projects', 'project', 'same'), 'utf8'),
    ).equal('older');
    should(await readFile(path.join(poolRoot, 'claude', 'history.jsonl'), 'utf8')).equal(
      '{"display":"one","timestamp":1}\n{"display":"two","timestamp":2}\n',
    );
    // Every emptied source directory named by the dry run is gone, replaced by the pool link.
    should((await lstat(path.join(homeB, 'projects'))).isSymbolicLink()).be.true();
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

  it('should migrate an account home that is a link to a directory inside the allowed roots', async () => {
    // Arrange — operators do park a home on a bigger volume and link it into the fleet layout.
    const root = await temporaryDirectory();
    const real = path.join(root, 'volume', 'claude-a');
    const home = path.join(root, 'fleet', 'homes', 'claude-a');
    const poolRoot = path.join(root, 'fleet', 'shared');
    await write(path.join(real, 'projects', 'project', 'session.jsonl'), 'evidence\n');
    await mkdir(path.dirname(home), { recursive: true });
    await symlink(real, home);
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    // Act
    const actual = await subject.materialize({ kind: 'claude', poolRoot, homes: [{ account: 'a', path: home }] });

    // Assert — the entry link lands inside the linked home and the root link is left alone.
    should(actual.migrated).equal(1);
    should((await lstat(home)).isSymbolicLink()).be.true();
    should(await readlink(home)).equal(real);
    should((await lstat(path.join(real, 'projects'))).isSymbolicLink()).be.true();
    should(await readFile(path.join(poolRoot, 'claude', 'projects', 'project', 'session.jsonl'), 'utf8')).equal(
      'evidence\n',
    );
  });

  it('should refuse a home whose link leaves the allowed roots, in the plan and again on apply', async () => {
    // Arrange — the configured roots are the writable surface, and a link cannot widen them.
    const root = await temporaryDirectory();
    const elsewhere = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'claude-a');
    const inside = path.join(root, 'fleet', 'homes', 'claude-b');
    const poolRoot = path.join(root, 'fleet', 'shared');
    await write(path.join(elsewhere, 'projects', 'project', 'session.jsonl'), 'foreign\n');
    await write(path.join(inside, 'projects', 'project', 'session.jsonl'), 'local\n');
    await symlink(elsewhere, home);
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));
    const migration: SharedHistoryRequest = {
      kind: 'claude',
      poolRoot,
      homes: [
        { account: 'a', path: home },
        { account: 'b', path: inside },
      ],
    };

    // Act
    const preview = await subject.preview(migration);
    const promise = subject.materialize(migration);

    // Assert — the plan stays readable and truthful; nothing outside the roots is read or written.
    should(preview.refusals).match([{ account: 'a', home, path: elsewhere, reason: /outside configured roots/ }]);
    should(preview.changes).matchAny({ kind: 'move', source: path.join(inside, 'projects') });
    await should(promise).be.rejectedWith(
      /refusing to migrate claude history while 1 account home\(s\) cannot be read/,
    );
    should((await lstat(path.join(inside, 'projects'))).isDirectory()).be.true();
    should(await readFile(path.join(elsewhere, 'projects', 'project', 'session.jsonl'), 'utf8')).equal('foreign\n');
  });

  it('should refuse one real home configured twice through an ancestor link, before planning it', async () => {
    // Arrange — this is the case a lexical compare and a one-level link walk both miss: `alias` is a
    // link to `real`, so `real/a` and `alias/a` are one directory holding one set of transcripts.
    const root = await temporaryDirectory();
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    const home = path.join(real, 'a');
    const transcript = path.join(home, 'projects', 'p1', 's.jsonl');
    await write(transcript, 'evidence\n');
    await write(path.join(home, 'history.jsonl'), '{"display":"one","timestamp":1}\n');
    await symlink(real, alias);
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    // Act
    const promise = subject.preview({
      kind: 'claude',
      poolRoot: path.join(root, 'fleet', 'shared'),
      homes: [
        { account: 'a1', path: home },
        { account: 'a2', path: path.join(alias, 'a') },
      ],
    });

    // Assert — the dry run refuses rather than announcing a collision between a file and itself.
    await should(promise).be.rejectedWith(/accounts a1 and a2 resolve to the same home directory/);
    should(await readFile(transcript, 'utf8')).equal('evidence\n');
    should(
      await subject.preview({
        kind: 'claude',
        poolRoot: path.join(root, 'fleet', 'shared'),
        homes: [{ account: 'a1', path: home }],
      }),
    ).match({ conflicts: 0, migrated: 2 });
  });

  it('should refuse homes that nest once their links are resolved', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const outer = path.join(root, 'outer');
    const alias = path.join(root, 'alias');
    await mkdir(path.join(outer, 'inner'), { recursive: true });
    await write(path.join(outer, 'projects', 'p1', 's.jsonl'), 'evidence\n');
    await symlink(outer, alias);
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    // Act
    const promise = subject.preview({
      kind: 'claude',
      poolRoot: path.join(root, 'fleet', 'shared'),
      homes: [
        { account: 'outer', path: outer },
        { account: 'inner', path: path.join(alias, 'inner') },
      ],
    });

    // Assert
    await should(promise).be.rejectedWith(/account homes must not contain one another/);
    should(await readFile(path.join(outer, 'projects', 'p1', 's.jsonl'), 'utf8')).equal('evidence\n');
  });

  it('should preserve, but not pool, prompt lines a live writer appends after the migration', async () => {
    // Arrange — the honest limit of a rename-based merge: an fd opened before the migration keeps
    // writing to the same inode, which is now the quarantined copy rather than the pooled file.
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'claude-a');
    const poolRoot = path.join(root, 'fleet', 'shared');
    const pooled = path.join(poolRoot, 'claude', 'history.jsonl');
    const source = path.join(home, 'history.jsonl');
    await write(pooled, '{"display":"pooled","timestamp":1}\n');
    await write(source, '{"display":"account","timestamp":2}\n');
    const writer = await open(source, 'a');
    const subject = new SharedHistoryMigration(new FileSharedHistoryFileSystem([root]));

    try {
      // Act
      const actual = await subject.materialize({ kind: 'claude', poolRoot, homes: [{ account: 'a', path: home }] });
      await writer.write('{"display":"late","timestamp":3}\n');
      await writer.sync();
      const merge = actual.changes.find(change => change.kind === 'merge-jsonl');
      const preserved = merge?.kind === 'merge-jsonl' ? merge.sourcePreservedAt : '';

      // Assert — the pooled file has both observed histories and none of the late line.
      should(await readFile(pooled, 'utf8')).equal(
        '{"display":"pooled","timestamp":1}\n{"display":"account","timestamp":2}\n',
      );
      // The late line is not lost: it is in the quarantined copy the plan already named.
      should(preserved).equal(path.join(poolRoot, 'claude', '.migration-conflicts', 'a', 'history.jsonl'));
      should(await readFile(preserved, 'utf8')).equal(
        '{"display":"account","timestamp":2}\n{"display":"late","timestamp":3}\n',
      );
    } finally {
      await writer.close();
    }
  });
});
