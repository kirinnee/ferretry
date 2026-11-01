import { afterEach, beforeEach, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { access, chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { GuardSizeError, NodeGuardDisk } from '../../src/adapters/node-guard-disk.ts';
import {
  copyTreeOutsideStateHomes,
  createOutsideStateHomes,
  MutableRootError,
  openOutsideStateHomes,
  resolveImmutableRoots,
  resolveStateHomes,
  type StateHomes,
} from '../../src/lib/state-home-guard.ts';

/**
 * THE STATE-HOME GUARD'S DISK, AGAINST A REAL ONE: that every open refuses a link at its last step, that a pipe
 * never hangs a read or a write, that identities are the kernel's, and — on Linux — that a write reaches the
 * folder that was CHECKED even when its path is swapped for a link into the home after the check.
 */

let root = '';
let home = '';
let work = '';
let homes: StateHomes;
const disk = new NodeGuardDisk();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-guard-disk-'));
  home = join(root, 'home');
  work = join(root, 'work');
  await mkdir(join(home, 'state'), { recursive: true });
  await mkdir(work);
  await writeFile(join(home, 'api-token'), 'fy_admin_token');
  await writeFile(join(home, 'state', 'secrets.key'), 'key');
  homes = await resolveStateHomes({ homes: [home] }, disk);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** This process's group ids, as `resolveImmutableRoots` takes them. */

const failure = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('NodeGuardDisk — reading', () => {
  it('should tell entries by kind, device and inode, report a missing one as nothing, and let other failures through', async () => {
    // Arrange
    await writeFile(join(work, 'a.txt'), 'abc');
    await link(join(work, 'a.txt'), join(work, 'b.txt'));
    await symlink(join(work, 'a.txt'), join(work, 'c.txt'));

    // Act
    const [a, b, c, folder] = await Promise.all(
      ['a.txt', 'b.txt', 'c.txt', '.'].map(async name => await disk.identity(join(work, name))),
    );
    const missing = await disk.identity(join(work, 'nope'));
    const tooLong = await failure(disk.identity(join(work, 'x'.repeat(300))));

    // Assert
    should(a).match({ kind: 'file', links: 2, size: 3 });
    should(b?.inode).equal(a?.inode);
    should(c?.kind).equal('link');
    should(folder?.kind).equal('directory');
    should(missing).be.undefined();
    should(tooLong).be.instanceOf(Error);
    should(await disk.readlink(join(work, 'c.txt'))).equal(join(work, 'a.txt'));
    should(await disk.realpath(join(work, 'c.txt'))).equal(join(work, 'a.txt'));
    should(await disk.list(work)).containEql('a.txt');
  });

  it('should read and copy through the open descriptor, stop at the cap, and refuse a link at the last step', async () => {
    // Arrange
    await writeFile(join(work, 'big.bin'), new Uint8Array(200_000));
    await writeFile(join(work, 'note.txt'), 'hello');
    await symlink(join(work, 'note.txt'), join(work, 'alias.txt'));

    // Act
    const big = await disk.openRead(join(work, 'big.bin'));
    const copied = await big.copyTo(join(work, 'copy.bin'), 1_000_000, 0o640);
    const over = await failure(big.copyTo(join(work, 'small.bin'), 100_000, 0o600));
    const taken = await failure(big.copyTo(join(work, 'copy.bin'), 1_000_000, 0o600));
    const tooMuchText = await failure(big.readText(10));
    await big.close();
    const note = await disk.openRead(join(work, 'note.txt'));
    const text = await note.readText(10);
    await note.close();
    const followed = await failure(disk.openRead(join(work, 'alias.txt')));

    // Assert
    should(copied).equal(200_000);
    should((await stat(join(work, 'copy.bin'))).mode & 0o777).equal(0o640);
    should(over).be.instanceOf(GuardSizeError);
    should(taken).be.instanceOf(Error);
    should(tooMuchText).be.instanceOf(GuardSizeError);
    should(text).equal('hello');
    should(followed).be.instanceOf(Error);
  });

  it('should open a pipe without waiting for a writer, for the guard to refuse', async () => {
    should(spawnSync('mkfifo', [join(work, 'pipe')]).status).equal(0);

    const read = await disk.openRead(join(work, 'pipe'));
    await read.close();
    const result = await openOutsideStateHomes(join(work, 'pipe'), homes, disk);

    should(read.identity.kind).equal('other');
    should(result).match({ ok: false, rule: 'not-a-file' });
  });
});

describe('NodeGuardDisk — writing', () => {
  it('should create only a new file, open an existing one without emptying it, and say which was missing', async () => {
    // Arrange
    await writeFile(join(work, 'old.txt'), 'old content');
    await writeFile(join(root, 'source.txt'), 'new');

    // Act
    const created = await disk.openWrite(join(work, 'new.txt'), 'new', 0o644);
    const taken = await disk.openWrite(join(work, 'old.txt'), 'new', 0o644);
    const absent = await disk.openWrite(join(work, 'nope.txt'), 'existing', 0o644);
    const existing = await disk.openWrite(join(work, 'old.txt'), 'existing', 0o644);
    const folder = await failure(disk.openWrite(work, 'existing', 0o644));
    if (typeof created === 'string' || typeof existing === 'string') throw new Error('both should open');
    const untouched = await readFile(join(work, 'old.txt'), 'utf8');
    await existing.truncate();
    await existing.copyFrom(join(root, 'source.txt'), 100);
    const over = await failure(created.copyFrom(join(root, 'source.txt'), 1));
    await existing.close();
    await created.close();

    // Assert
    should([taken, absent]).deepEqual(['taken', 'absent']);
    should(folder).be.instanceOf(Error);
    should(untouched).equal('old content');
    should(await readFile(join(work, 'old.txt'), 'utf8')).equal('new');
    should(over).be.instanceOf(GuardSizeError);
    should((await stat(join(work, 'new.txt'))).mode & 0o777).equal(0o644);
  });

  it('should never hang on a pipe put where a file is written', async () => {
    should(spawnSync('mkfifo', [join(work, 'pipe')]).status).equal(0);

    const opened = await failure(disk.openWrite(join(work, 'pipe'), 'existing', 0o644));

    should(opened).be.instanceOf(Error);
  });

  it('should open a folder, name its entries through the descriptor only where asked, and make and remove entries', async () => {
    // Arrange
    const plain = new NodeGuardDisk(false);

    // Act
    const folder = await disk.openDirectory(work);
    const through = folder.entryPath('x');
    await folder.close();
    const pathOnly = await plain.openDirectory(work);
    const none = pathOnly.entryPath('x');
    await pathOnly.close();
    const notFolder = await failure(disk.openDirectory(join(home, 'api-token')));
    await disk.mkdir(join(work, 'made'), 0o750);
    await writeFile(join(work, 'made', 'f'), 'x');
    await disk.unlink(join(work, 'made', 'f'));

    // Assert
    if (process.platform === 'linux') should(through).match(/^\/proc\/self\/fd\/\d+\/x$/u);
    else should(through).be.undefined();
    should(none).be.undefined();
    should(notFolder).be.instanceOf(Error);
    should((await stat(join(work, 'made'))).mode & 0o777).equal(0o750);
    should(await disk.list(join(work, 'made'))).deepEqual([]);
  });

  it.skipIf(process.platform !== 'linux')(
    'should write into the CHECKED folder when its path is swapped for a link into the home after the check',
    async () => {
      // Arrange: the moment the file is opened, `downloads` is renamed away and a link to the home put there.
      await mkdir(join(work, 'downloads'));
      await writeFile(join(root, 'page.bin'), 'from the page');
      class Racing extends NodeGuardDisk {
        override async openWrite(path: string, how: 'new' | 'existing', mode: number) {
          await rename(join(work, 'downloads'), join(work, 'downloads-was'));
          await symlink(join(home, 'state'), join(work, 'downloads'));
          return await super.openWrite(path, how, mode);
        }
      }

      // Act
      const result = await createOutsideStateHomes(join(work, 'downloads', 'secrets.key'), homes, new Racing(), {
        inside: work,
        overwrite: false,
        mode: 0o644,
      });

      // Assert: refused, the home's key untouched, and the file it made in the checked folder removed again.
      should(result).match({ ok: false, rule: 'changed' });
      should(await readFile(join(home, 'state', 'secrets.key'), 'utf8')).equal('key');
      should(await disk.list(join(work, 'downloads-was'))).deepEqual([]);
    },
  );
});

describe('copyTreeOutsideStateHomes — on a real disk', () => {
  it('should copy a read-only folder (as the Nix store keeps them) and give the copy its modes', async () => {
    // Arrange
    const source = join(root, 'store');
    await mkdir(join(source, 'skills'), { recursive: true });
    await writeFile(join(source, 'skills', 'SKILL.md'), 'skill');
    await chmod(join(source, 'skills', 'SKILL.md'), 0o444);
    await chmod(join(source, 'skills'), 0o555);
    await chmod(source, 0o555);

    // Act
    const result = await copyTreeOutsideStateHomes(source, join(work, 'copy'), homes, disk, {
      maxFileBytes: 1000,
      maxTotalBytes: 10_000,
      maxFiles: 10,
    });

    // Assert
    should(result).deepEqual({ ok: true, value: { files: 1, bytes: 5 } });
    should((await stat(join(work, 'copy', 'skills'))).mode & 0o777).equal(0o555);
    should((await stat(join(work, 'copy', 'skills', 'SKILL.md'))).mode & 0o777).equal(0o444);
    await chmod(join(work, 'copy', 'skills'), 0o755);
    await chmod(join(work, 'copy'), 0o755);
    await chmod(join(source, 'skills'), 0o755);
    await chmod(source, 0o755);
  });
});

describe('the guard on a real disk — folders, owners and immutable roots', () => {
  it('should make missing folders through the checked one, with their mode', async () => {
    await writeFile(join(root, 'source.txt'), 'bytes');

    const made = await createOutsideStateHomes(join(work, 'a', 'b', 'c.txt'), homes, disk, {
      inside: work,
      overwrite: false,
      mode: 0o644,
      makeFolders: 0o750,
    });
    if (!made.ok) throw new Error(made.rule);
    await made.value.copyFrom(join(root, 'source.txt'), 100);
    await made.value.close();

    should(await readFile(join(work, 'a', 'b', 'c.txt'), 'utf8')).equal('bytes');
    should((await stat(join(work, 'a', 'b'))).mode & 0o777).equal(0o750);
  });

  it('should refuse a folder this user owns, and one anyone may write, as an immutable root', async () => {
    const mine = await resolveImmutableRoots([work], disk).catch((error: unknown) => error);
    const shared = await resolveImmutableRoots([tmpdir()], disk).catch((error: unknown) => error);

    should(mine).be.instanceOf(MutableRootError);
    should(shared).be.instanceOf(MutableRootError);
  });

  it('should read this process’s own groups, and answer a write the kernel would allow or refuse', async () => {
    const groups = await disk.groups();

    should(groups).containEql(process.getegid?.() ?? -1);
    should(await disk.writable(work)).be.true();
    should(await disk.writable('/')).equal(process.getuid?.() === 0);
  });

  it('should read the groups a group file lists this user in, none when there is no file, and throw when it cannot read one', async () => {
    // Arrange
    const user = userInfo().username;
    const listed = join(work, 'group');
    await writeFile(listed, `wheel:x:4242:${user},other\nnobody:x:4243:other\n`);

    // Act
    const groups = await new NodeGuardDisk(true, listed).groups();
    const absent = await new NodeGuardDisk(true, join(work, 'no-group-file')).groups();
    const unreadable = await new NodeGuardDisk(true, work).groups().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: a folder in the file's place is not "no groups"; it refuses the proof.
    should(groups).containEql(4242);
    should(groups).not.containEql(4243);
    should(absent).not.containEql(4242);
    should((unreadable as NodeJS.ErrnoException | undefined)?.code).equal('EISDIR');
  });

  it('should throw, not answer, when it cannot ask about a path that is not there', async () => {
    // Fail closed: a caller that cannot tell must not read "not writable" as "closed".
    const failed = await disk.writable(join(work, 'nowhere')).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((failed as NodeJS.ErrnoException | undefined)?.code).equal('ENOENT');
  });

  it('should accept a multi-user Nix store where there is one', async () => {
    const present = await access('/nix/store').then(
      () => true,
      () => false,
    );
    const info = present ? await stat('/nix/store') : undefined;
    // Only a root-owned store this user's groups cannot write qualifies; anything else is refused, which is right too.
    const groups = await disk.groups();
    const qualifies =
      info !== undefined &&
      info.uid === 0 &&
      (info.mode & 0o002) === 0 &&
      ((info.mode & 0o020) === 0 || !groups.includes(info.gid)) &&
      !(await disk.writable('/nix/store'));

    const roots = await resolveImmutableRoots(['/nix/store'], disk).then(
      result => result.roots,
      () => undefined,
    );

    should(roots).eql(qualifies ? ['/nix/store'] : undefined);
  });
});
