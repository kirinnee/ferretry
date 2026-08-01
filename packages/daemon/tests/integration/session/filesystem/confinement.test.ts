import { afterAll, describe, it } from 'bun:test';
import { mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { BunGitRunner } from '../../../../src/adapters/git/index.ts';
import { ProcfsSessionRootPinner, RunnerSessionGit } from '../../../../src/adapters/session/filesystem/index.ts';
import {
  FsError,
  type PinnedRoot,
  type PinnedTarget,
  SessionFilesystem,
} from '../../../../src/lib/session/filesystem/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

/**
 * Containment, against the real kernel.
 *
 * Every test here attempts an escape and asserts a refusal, or swaps the tree underneath a request and
 * asserts that the bytes still come from the object that passed the gates. This is the file that has to be
 * believed: the domain's unit tests run against a fake walk and say nothing about whether `O_NOFOLLOW`
 * actually refuses a symlink, and a viewer whose confinement is 80% correct is more dangerous than one with
 * none, because callers trust it.
 *
 * The tree is a throwaway temp directory. Nothing here touches a real state home, binds a port, or reaches
 * the network.
 */

const pinner = new ProcfsSessionRootPinner();
const filesystem = new SessionFilesystem(pinner, new RunnerSessionGit(new BunGitRunner()));

/** A worktree-shaped fixture plus a sibling tree that nothing inside it may ever reach. */
interface Fixture {
  readonly root: string;
  readonly outside: string;
}

async function fixture(label = 'confine'): Promise<Fixture> {
  const root = await tempDirectory(label);
  const outside = await tempDirectory(`${label}-outside`);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'PINNED\n');
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE\n');
  return { root, outside };
}

const refusalFrom = async (act: () => Promise<unknown>): Promise<FsError> => {
  try {
    await act();
  } catch (error) {
    if (error instanceof FsError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** Runs `act` with a pinned root, always closing it. */
async function withPin<Result>(cwd: string, act: (pinned: PinnedRoot) => Promise<Result>): Promise<Result> {
  const pinned = await pinner.pin(cwd);
  try {
    return await act(pinned);
  } finally {
    await pinned.close();
  }
}

async function withTarget<Result>(
  cwd: string,
  rel: string,
  act: (target: PinnedTarget, pinned: PinnedRoot) => Promise<Result>,
): Promise<Result> {
  return await withPin(cwd, async pinned => {
    const target = await pinned.open(rel);
    try {
      return await act(target, pinned);
    } finally {
      await target.close();
    }
  });
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('pinning a session root', () => {
  it('should refuse a cwd that does not exist', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await pinner.pin(path.join(root, 'nope')));

    // Assert
    should(error.code).eql('not_found');
  });

  it('should refuse a cwd that is a file rather than a directory', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await pinner.pin(path.join(root, 'src', 'a.ts')));

    // Assert
    should(error.code).eql('not_a_directory');
  });

  it('should refuse a root inside the object store, which would make every relative path innocent', async () => {
    // Arrange: with a cwd of `<repo>/.git`, the request `config` has no denied segment at all.
    const { root } = await fixture();
    await mkdir(path.join(root, '.git'), { recursive: true });

    // Act
    const error = await refusalFrom(async () => await pinner.pin(path.join(root, '.git')));

    // Assert
    should(error.code).eql('denied');
    should(error.message).match(/session cwd is not served/);
  });

  it('should refuse a root whose own basename is denylisted', async () => {
    // Arrange
    const { root } = await fixture();
    await mkdir(path.join(root, '.env'), { recursive: true });

    // Act
    const error = await refusalFrom(async () => await pinner.pin(path.join(root, '.env')));

    // Assert
    should(error.code).eql('denied');
  });

  it('should report the root it actually HOLDS, so a symlinked cwd cannot launder a denied directory', async () => {
    // Arrange: `alias -> <root>/.git`. The name is innocent; the object is not.
    const { root } = await fixture();
    await mkdir(path.join(root, '.git'), { recursive: true });
    const alias = path.join(root, 'alias');
    await symlink(path.join(root, '.git'), alias);

    // Act
    const error = await refusalFrom(async () => await pinner.pin(alias));

    // Assert
    should(error.code).eql('denied');
  });

  it('should accept a root reached through a symlink and report its real location', async () => {
    // Arrange: a session cwd legitimately reached through a link is ordinary.
    const { root } = await fixture();
    const alias = path.join(await tempDirectory('alias-home'), 'work');
    await symlink(root, alias);

    // Act
    const reported = await filesystem.resolveRoot(alias);

    // Assert
    should(reported).eql(root);
  });
});

describe('escaping the session root', () => {
  it('should refuse a "../" traversal before the filesystem is touched at all', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, '../secret.txt'));

    // Assert
    should(error.code).eql('invalid_path');
  });

  it('should refuse an absolute path that shares a prefix with the root', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, `${root}/src/a.ts`));

    // Assert
    should(error.code).eql('invalid_path');
  });

  it('should refuse a symlink LEAF whose target is outside the tree, and name it as an escape', async () => {
    // Arrange
    const { root, outside } = await fixture();
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'leak.txt'));

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'src/leak.txt'));

    // Assert
    should(error.code).eql('escapes_root');
    should(error.message).match(/escapes the session root/);
  });

  it('should refuse a symlinked DIRECTORY component pointing outside the tree', async () => {
    // Arrange: `src/away -> <outside>`, then read through it.
    const { root, outside } = await fixture();
    await symlink(outside, path.join(root, 'src', 'away'));

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'src/away/secret.txt'));

    // Assert
    should(error.code).eql('escapes_root');
  });

  it('should refuse an IN-TREE symlinked directory too, rather than resolving and containing it', async () => {
    // Arrange: a deliberate narrowing. It costs browsing through an in-tree link and buys a containment
    // proof that does not depend on winning a race.
    const { root } = await fixture();
    await symlink(path.join(root, 'src'), path.join(root, 'inside'));

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'inside/a.ts'));

    // Assert
    should(error.code).eql('not_a_file');
    should(error.message).match(/symlinks are not served/);
  });

  it('should refuse an in-tree symlinked FILE, so no leaf is ever served through a link', async () => {
    // Arrange
    const { root } = await fixture();
    await symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'src', 'b.ts'));

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'src/b.ts'));

    // Assert
    should(error.code).eql('not_a_file');
  });

  it('should refuse a broken symlink, which has nothing to serve either way', async () => {
    // Arrange
    const { root } = await fixture();
    await symlink(path.join(root, 'gone.txt'), path.join(root, 'dangling.txt'));

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'dangling.txt'));

    // Assert
    should(error.code).eql('not_a_file');
  });

  it('should refuse the object store and the dependency tree by name', async () => {
    // Arrange
    const { root } = await fixture();
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\n');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

    // Act
    const gitConfig = await filesystem.readFile(root, '.git/config');
    const dependency = await filesystem.readFile(root, 'node_modules/pkg/index.js');
    const listing = await refusalFrom(async () => await filesystem.list(root, '.git'));

    // Assert
    should(gitConfig.denied).be.true();
    should(gitConfig.content).be.undefined();
    should(dependency.denied).be.true();
    should(listing.code).eql('denied');
  });

  it('should refuse a file where a directory was required', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'src/a.ts/inner'));

    // Assert
    should(error.code).eql('not_a_directory');
  });

  it('should report an unusably long name as missing rather than as a crash', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'x'.repeat(5000)));

    // Assert
    should(error.code).eql('not_found');
  });
});

describe('swapping the tree mid-request', () => {
  it('should serve the pinned bytes when the LEAF is replaced by a link to another tree', async () => {
    // Arrange: the swap lands after the descriptor is held, which is the whole window.
    const { root, outside } = await fixture();

    // Act
    const served = await withTarget(root, 'src/a.ts', async target => {
      await rm(path.join(root, 'src', 'a.ts'));
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'a.ts'));
      return text(await target.read(1024));
    });

    // Assert
    should(served).eql('PINNED\n');
  });

  it('should serve the pinned bytes when the ROOT itself is renamed away and symlinked elsewhere', async () => {
    // Arrange: this is the swap a `realpath`-then-reopen implementation loses to outright.
    const { root, outside } = await fixture();
    await mkdir(path.join(outside, 'src'), { recursive: true });
    await writeFile(path.join(outside, 'src', 'a.ts'), 'OUTSIDE\n');

    // Act
    const served = await withPin(root, async pinned => {
      await rename(root, `${root}-moved`);
      await symlink(outside, root);
      const target = await pinned.open('src/a.ts');
      try {
        return text(await target.read(1024));
      } finally {
        await target.close();
      }
    });

    // Assert
    should(served).eql('PINNED\n');
  });

  it('should refuse rather than serve when a component changed while the ignore policy was checked', async () => {
    // Arrange: the domain re-walks the lexical name after Git answers, and the re-walk now finds a link.
    const { root, outside } = await fixture();

    // Act
    const error = await refusalFrom(
      async () =>
        await filesystem.readFile(root, 'src/a.ts', {
          afterValidation: async () => {
            await rm(path.join(root, 'src', 'a.ts'));
            await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'a.ts'));
          },
        }),
    );

    // Assert
    should(error.code).eql('not_found');
    should(error.message).match(/changed while its secrets policy/);
  });

  it('should refuse when a PARENT directory is swapped for a link inside the window', async () => {
    // Arrange
    const { root, outside } = await fixture();
    await mkdir(path.join(outside, 'src'), { recursive: true });
    await writeFile(path.join(outside, 'src', 'a.ts'), 'OUTSIDE\n');

    // Act
    const error = await refusalFrom(
      async () =>
        await filesystem.readFile(root, 'src/a.ts', {
          afterValidation: async () => {
            await rename(path.join(root, 'src'), path.join(root, 'src-real'));
            await symlink(path.join(outside, 'src'), path.join(root, 'src'));
          },
        }),
    );

    // Assert
    should(error.code).eql('not_found');
  });

  it('should refuse a LISTING whose directory was swapped inside the window', async () => {
    // Arrange
    const { root, outside } = await fixture();

    // Act
    const error = await refusalFrom(
      async () =>
        await filesystem.list(root, 'src', {
          afterValidation: async () => {
            await rename(path.join(root, 'src'), path.join(root, 'src-real'));
            await symlink(outside, path.join(root, 'src'));
          },
        }),
    );

    // Assert
    should(error.code).eql('not_found');
  });

  it('should refuse a DIFF whose leaf was swapped inside the window', async () => {
    // Arrange
    const { root, outside } = await fixture();

    // Act
    const error = await refusalFrom(
      async () =>
        await filesystem.diff(root, 'src/a.ts', {
          afterValidation: async () => {
            await rm(path.join(root, 'src', 'a.ts'));
            await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'a.ts'));
          },
        }),
    );

    // Assert
    should(error.code).eql('not_found');
  });

  it('should detect an ABA rename, where the name resolves to the original inode again', async () => {
    // Arrange: dev+ino are unchanged by the round trip, so ctime is what catches it.
    const { root } = await fixture();
    const original = path.join(root, 'src');
    const parked = path.join(root, 'parked');

    // Act
    const error = await refusalFrom(
      async () =>
        await filesystem.list(root, 'src', {
          afterValidation: async () => {
            await rename(original, parked);
            await rename(parked, original);
          },
        }),
    );

    // Assert
    should(error.code).eql('not_found');
    should(error.message).match(/changed while its secrets policy/);
  });
});

describe('reading and enumerating through the pin', () => {
  it('should serve a regular file from the descriptor the walk produced', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const view = await filesystem.readFile(root, 'src/a.ts');

    // Assert
    should(view.path).eql('src/a.ts');
    should(view.content).eql('PINNED\n');
    should(view.size).eql(7);
  });

  it('should refuse to read a directory as a file', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(root, 'src'));

    // Assert
    should(error.code).eql('not_a_file');
  });

  it('should report a file over the cap without reading it', async () => {
    // Arrange
    const { root } = await fixture();
    await writeFile(path.join(root, 'big.bin'), new Uint8Array(4096));

    // Act
    const view = await filesystem.readFile(root, 'big.bin', { maxBytes: 16 });

    // Assert
    should(view.tooLarge).be.true();
    should(view.size).eql(4096);
  });

  it('should decline to read past its cap at the descriptor level too', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const bytes = await withTarget(root, 'src/a.ts', async target => await target.read(2));

    // Assert
    should(bytes).be.undefined();
  });

  it('should serve what exists when the file is truncated under the read', async () => {
    // Arrange: the size came from the open handle; the file is then emptied before the read.
    const { root } = await fixture();

    // Act
    const bytes = await withTarget(root, 'src/a.ts', async target => {
      await truncate(path.join(root, 'src', 'a.ts'), 0);
      return await target.read(1024);
    });

    // Assert
    should(bytes).eql(new Uint8Array());
  });

  it('should call a file with a NUL in its opening bytes binary', async () => {
    // Arrange
    const { root } = await fixture();
    await writeFile(path.join(root, 'blob.bin'), new Uint8Array([1, 2, 0, 3]));

    // Act
    const view = await filesystem.readFile(root, 'blob.bin');

    // Assert
    should(view.binary).be.true();
    should(view.content).be.undefined();
  });

  it('should enumerate the root with directories first and real sizes attached', async () => {
    // Arrange
    const { root } = await fixture();
    await writeFile(path.join(root, 'README.md'), '# hi\n');

    // Act
    const listing = await filesystem.list(root);

    // Assert
    should(listing.root).eql(root);
    should(listing.entries.map(entry => entry.name)).eql(['src', 'README.md']);
    should(listing.entries[0]?.type).eql('dir');
    should(listing.entries[1]).match({ name: 'README.md', type: 'file', size: 5 });
    should(listing.entries[1]?.mtime).be.a.String();
  });

  it('should badge a listed symlink by where it actually points', async () => {
    // Arrange
    const { root, outside } = await fixture();
    await mkdir(path.join(root, '.git'), { recursive: true });
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'away'));
    await symlink(path.join(root, '.git'), path.join(root, 'alias'));
    await symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'near'));
    await symlink(path.join(root, 'missing'), path.join(root, 'broken'));

    // Act
    const listing = await filesystem.list(root);
    const byName = new Map(listing.entries.map(entry => [entry.name, entry]));

    // Assert
    should(byName.get('away')).match({ type: 'symlink', escapes: true });
    should(byName.get('broken')).match({ type: 'symlink', escapes: true });
    should(byName.get('alias')).match({ type: 'symlink', denied: true });
    // An in-root link reports the TARGET's size, because a link's own metadata is useless to a viewer.
    should(byName.get('near')).match({ type: 'symlink', size: 7 });
  });

  it('should omit a device-like entry no viewer can render', async () => {
    // Arrange: a fifo is neither a file, a directory nor a link.
    const { root } = await fixture();
    const fifo = Bun.spawn(['mkfifo', path.join(root, 'pipe')], { stdout: 'ignore', stderr: 'ignore' });
    should(await fifo.exited).eql(0);

    // Act
    const listing = await filesystem.list(root);

    // Assert
    should(listing.entries.map(entry => entry.name)).not.containEql('pipe');
  });

  it('should stop one entry past its cap and say so', async () => {
    // Arrange
    const { root } = await fixture();
    for (const name of ['one', 'two', 'three']) await writeFile(path.join(root, name), name);

    // Act
    const listing = await withTarget(root, '', async target => await target.list(2));

    // Assert
    should(listing.entries).have.length(2);
    should(listing.truncated).be.true();
  });

  it('should report a listing that fits as untruncated', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const listing = await withTarget(root, '', async target => await target.list(50));

    // Assert
    should(listing.truncated).be.false();
    should(listing.entries.map(entry => entry.name)).eql(['src']);
  });

  it('should describe a child whose name vanished between the readdir and the stat', async () => {
    // Arrange: the entry is real when enumerated and gone when described, which must not throw.
    const { root } = await fixture();
    const doomed = path.join(root, 'zzz-doomed');
    await writeFile(doomed, 'x');

    // Act
    const entries = await withTarget(root, '', async target => {
      // `src` sorts before `zzz-doomed`, so the unlink lands mid-enumeration on a lazily read dirent.
      const listing = target.list(50);
      await rm(doomed, { force: true });
      return (await listing).entries;
    });

    // Assert: whichever way the race fell, the enumeration completed.
    should(entries.map(entry => entry.name)).containEql('src');
  });

  it('should resolve the root itself as the empty relative path', async () => {
    // Arrange
    const { root } = await fixture();

    // Act
    const target = await filesystem.resolve(root, 'src');

    // Assert
    should(target).eql({ rootReal: root, rel: 'src', absolute: path.join(root, 'src') });
  });
});
