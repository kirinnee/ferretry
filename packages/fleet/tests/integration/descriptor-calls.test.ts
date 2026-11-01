import { afterEach, describe, it, spyOn } from 'bun:test';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { DescriptorBracket, descriptorHandle } from '../../src/adapters/descriptor-calls.ts';
import { DestinationFolders, readFolderFile } from '../../src/adapters/destination-folders.ts';
import { copyFencedSourceInto, resolveSourceFence } from '../../src/adapters/fenced-source.ts';
import { loadDirectorySyscalls } from '../../src/adapters/directory-syscalls.ts';
import { loadLinkSyscall } from '../../src/adapters/link-syscall.ts';
import { fileIdentityOf, NodeGuardDisk } from '../../src/adapters/node-guard-disk.ts';
import { WorkingDirectory } from '../../src/adapters/working-directory.ts';
import { type GuardedFolder, resolveStateHomes } from '../../src/lib/state-home-guard.ts';

/**
 * The destination side's descriptor calls on a real kernel: macOS's mechanism (a held folder installed by `fchdir`
 * for one synchronous call on a relative name, proven there first), which any POSIX host can run — so this file runs
 * on Linux in every pull request and on macOS in the Containment (macOS) job.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-descriptor-calls-')));
  directories.push(directory);
  return directory;
}

/** A state home with its vault key, and a runtime's skills folder holding one item. */
async function world() {
  const machine = await temporary();
  const home = path.join(machine, '.ferretry');
  const state = path.join(home, 'state');
  const skills = path.join(home, 'fleet', 'homes', 'one', 'skills');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'secrets.key'), 'vault-key\n');
  await mkdir(path.join(skills, 'stale'), { recursive: true });
  await writeFile(path.join(skills, 'stale', 'SKILL.md'), 'stale\n');
  const homes = await resolveStateHomes({ homes: [home, state] }, new NodeGuardDisk());
  const folders = new DestinationFolders(homes, new NodeGuardDisk('calls'));
  return { machine, home, state, skills, folders };
}

const opened = async (folders: DestinationFolders, folder: string): Promise<GuardedFolder> => {
  const found = await folders.existing(folder);
  if (found === undefined) throw new Error(`no folder at ${folder}`);
  return found;
};

describe('descriptor calls — every step reaches the folder that was opened', () => {
  it('should keep acting on the held folder after its path is swapped for a link into the home', async () => {
    // Arrange — the folder is opened and checked; then the harness renames it away and leaves a link into the
    // home's state folder at its name. A step made by path from here on would act on the home.
    const { state, skills, folders } = await world();
    const folder = await opened(folders, skills);
    const moved = `${skills}-moved`;
    await rename(skills, moved);
    await symlink(state, skills);

    try {
      // Act — every kind of step, through the held folder.
      const listed = await folder.list();
      const key = await folder.describe('secrets.key');
      await folder.rename('stale', 'renamed');
      await folder.mkdir('made', 0o700);
      await folder.symlink('/nowhere', 'pointer');
      const descriptor = await folder.openFile('written.txt', 'new', 0o600);
      await Bun.write(Bun.file(descriptor), 'ours\n');
      await folder.link(folder, 'written.txt', 'second-name.txt');
      await folders.remove(folder, 'renamed');

      // Assert — it all happened in the folder that was opened, and the home is exactly as it was.
      should(listed).deepEqual(['stale']);
      should(key).be.undefined();
      should((await readdir(moved)).toSorted()).deepEqual(['made', 'pointer', 'second-name.txt', 'written.txt']);
      should(await readFile(path.join(moved, 'second-name.txt'), 'utf8')).equal('ours\n');
      should(await readlink(path.join(moved, 'pointer'))).equal('/nowhere');
      should((await readdir(state)).toSorted()).deepEqual(['secrets.key']);
      should(await readFile(path.join(state, 'secrets.key'), 'utf8')).equal('vault-key\n');
    } finally {
      await folder.close();
    }
  });

  it('should leave the runtime in its own working directory after every step', async () => {
    // Arrange
    const { skills, folders } = await world();
    const syscalls = loadDirectorySyscalls();
    const before = syscalls.currentDirectory();
    const folder = await opened(folders, skills);

    // Act
    await folder.list();
    await folder.mkdir('made', 0o700);
    await folder.describe('made').catch(() => undefined);
    await folder.rmdir('missing').catch(() => undefined);

    // Assert — every bracket put the kernel's working directory back, even around a step that failed.
    should(syscalls.currentDirectory()).equal(before);
    await folder.close();
  });
});

/** A stop that throws instead of exiting, so a test can see it. */
const stopped = (reason: string): never => {
  throw new Error(`stopped: ${reason}`);
};

describe('DescriptorBracket — what it refuses', () => {
  /**
   * The C calls, with `fchdir` answered by `answer` (the real one runs when it returns `undefined`), over the shared
   * working directory `directory` — never this test process's own, which every other test relies on.
   */
  const bracketWith = (
    answer: (fd: number, call: number) => number | undefined,
    directory: WorkingDirectory = new WorkingDirectory(stopped),
  ) => {
    const real = loadDirectorySyscalls();
    let calls = 0;
    return new DescriptorBracket(
      {
        fchdir: fd => {
          calls += 1;
          return answer(fd, calls) ?? real.fchdir(fd);
        },
        currentDirectory: () => real.currentDirectory(),
      },
      loadLinkSyscall(),
      directory,
    );
  };
  const caught = (act: () => unknown): unknown => {
    try {
      return act();
    } catch (error) {
      return error;
    }
  };

  it('should fall back to / and refuse every later step of every bracket once the restore fails', async () => {
    // Arrange — two brackets on one working directory, as the provisioner's and the session pinner's are. The install
    // and the fall-back install are no-ops here, so nothing really moves; the restore of the runtime's own fails.
    const here = fileIdentityOf(lstatSync('.', { bigint: true }));
    const directory = new WorkingDirectory(stopped);
    const failing = bracketWith((_fd, call) => (call === 2 ? -1 : 0), directory);
    const other = bracketWith(() => 0, directory);
    let ran = 0;

    // Act
    const first = caught(() => failing.run(0, here, () => (ran += 1)));
    const later = caught(() => failing.run(0, here, () => (ran += 1)));
    const elsewhere = caught(() => other.run(0, here, () => (ran += 1)));

    // Assert — the step that failed to restore reports it, and nothing of either bracket runs after.
    should((first as Error).message).match(/refusing to go on: the working directory could not be restored/u);
    should((later as Error).message).match(/refusing to reach a folder through its descriptor/u);
    should((elsewhere as Error).message).match(/refusing to reach a folder through its descriptor/u);
    should(directory.broken).match(/could not be restored/u);
    should(ran).equal(1);
  });

  it('should stop when not even / can be installed or opened after a failed restore', () => {
    // Arrange
    const directory = new WorkingDirectory(stopped);
    const unopenable = new WorkingDirectory(stopped, () => {
      throw new Error('EACCES');
    });

    // Act + Assert
    should(() => directory.restore(() => -1, 0)).throw(/stopped: .*\/ could not be installed instead/u);
    should(() => unopenable.restore(() => -1, 0)).throw(/stopped: .*\/ could not be opened instead/u);
    should(new WorkingDirectory(stopped).restore(() => 0, 0)).be.true();
  });

  it('should exit the process, saying why, when it has to stop', () => {
    // Arrange — the exit is caught here, so the test process goes on.
    const said: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      said.push(String(text));
      return true;
    }) as typeof process.stderr.write);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${String(code)}`);
    }) as typeof process.exit);

    try {
      // Act
      const outcome = caught(() => new WorkingDirectory().restore(() => -1, 0));

      // Assert
      should((outcome as Error).message).equal('exit 70');
      should(said.join('')).match(/could not be installed instead: stopping rather than running on/u);
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it('should refuse a hard link whose held folder is no longer the one it was opened on', async () => {
    // Arrange — a descriptor that now names another folder (as a closed one reused would).
    const { machine, skills } = await world();
    const bracket = new DescriptorBracket(loadDirectorySyscalls(), loadLinkSyscall(), new WorkingDirectory(stopped));
    const other = openSync(machine, constants.O_RDONLY | constants.O_DIRECTORY);
    const was = fileIdentityOf(await lstat(skills, { bigint: true }));

    try {
      // Act + Assert
      should(() => bracket.linkat({ fd: other, identity: was }, 'a', { fd: other, identity: was }, 'b')).throw(
        /no longer the one it was opened on/u,
      );
    } finally {
      closeSync(other);
    }
  });

  it('should refuse to link into a folder that is not held by a descriptor', async () => {
    // Arrange
    const { skills, folders } = await world();
    await writeFile(path.join(skills, 'a'), 'a');
    const folder = await opened(folders, skills);
    const handle = descriptorHandle(
      openSync(skills, constants.O_RDONLY | constants.O_DIRECTORY),
      new DescriptorBracket(loadDirectorySyscalls(), loadLinkSyscall(), new WorkingDirectory(stopped)),
      fileIdentityOf,
    );

    // Act + Assert
    await should(
      handle.at?.link(
        'a',
        {
          identity: folder.identity,
          entryPath: () => undefined,
          chmod: async () => undefined,
          sync: async () => undefined,
          close: async () => undefined,
        },
        'b',
      ),
    ).be.rejectedWith(/not held/u);
    await handle.close();
    await folder.close();
  });

  it('should refuse a step whose relative name does not reach the folder installed', async () => {
    // Arrange — the install "succeeds" without moving, so `.` is wherever the runtime stands, not the folder.
    const { skills } = await world();
    const folder = fileIdentityOf(await lstat(skills, { bigint: true }));
    const bracket = bracketWith(() => 0);
    let ran = false;

    // Act
    const outcome = (() => {
      try {
        return bracket.run(0, folder, () => {
          ran = true;
        });
      } catch (error) {
        return error;
      }
    })();

    // Assert
    should((outcome as Error).message).match(/did not reach the folder installed/u);
    should(ran).be.false();
  });

  it('should rename across two held folders, and name the errno of a rename that fails', async () => {
    // Arrange
    const { skills, folders } = await world();
    await writeFile(path.join(skills, 'moving'), 'm');
    await mkdir(path.join(skills, 'into'));
    const folder = await opened(folders, skills);
    const into = await opened(folders, path.join(skills, 'into'));

    // Act
    await folder.renameInto('moving', into, 'moved');
    const outcome = await folder.renameInto('never-there', into, 'x').catch((error: unknown) => error);
    const link = await folder.readlink('missing').catch((error: unknown) => error);

    // Assert
    should(await readFile(path.join(skills, 'into', 'moved'), 'utf8')).equal('m');
    should((outcome as NodeJS.ErrnoException).code).equal('ENOENT');
    should((link as NodeJS.ErrnoException).code).equal('ENOENT');
    await into.close();
    await folder.close();
  });

  it('should name the errno of a hard link that fails', async () => {
    // Arrange
    const { skills, folders } = await world();
    const folder = await opened(folders, skills);
    await writeFile(path.join(skills, 'a'), 'a');
    await writeFile(path.join(skills, 'b'), 'b');

    // Act
    const outcome = await folder.link(folder, 'a', 'b').catch((error: unknown) => error);

    // Assert — refused rather than replacing, with the kernel's own code.
    should((outcome as NodeJS.ErrnoException).code).equal('EEXIST');
    should(await readFile(path.join(skills, 'b'), 'utf8')).equal('b');
    await folder.close();
  });
});

describe('descriptor calls — the rest of each step', () => {
  it('should read a file and copy a tree through descriptor calls', async () => {
    // Arrange
    const { machine, skills, folders } = await world();
    const source = path.join(machine, 'source');
    await mkdir(path.join(source, 'sub'), { recursive: true });
    await writeFile(path.join(source, 'a.md'), 'alpha\n');
    await writeFile(path.join(source, 'sub', 'b.md'), 'beta\n');
    const folder = await opened(folders, skills);
    const fence = await resolveSourceFence(
      { homes: [path.join(machine, '.ferretry')], open: [] },
      new NodeGuardDisk('calls'),
    );

    // Act
    await copyFencedSourceInto(fence, source, folder, 'copied');
    const read = await readFolderFile(await opened(folders, path.join(skills, 'copied')), 'a.md');

    // Assert
    should(read.toString('utf8')).equal('alpha\n');
    should(await readFile(path.join(skills, 'copied', 'sub', 'b.md'), 'utf8')).equal('beta\n');
    await folder.close();
  });

  it('should surface a name the kernel refuses for any reason but its absence', async () => {
    // Arrange
    const { skills, folders } = await world();
    const folder = await opened(folders, skills);

    // Act + Assert — a name too long for the kernel is not an absent entry.
    await should(folder.describe('x'.repeat(4096))).be.rejectedWith(/ENAMETOOLONG/u);
    await folder.close();
  });

  it('should refuse a descriptor that cannot be described, closing it', () => {
    // Arrange — a descriptor number nothing holds.
    const bracket = new DescriptorBracket(loadDirectorySyscalls(), loadLinkSyscall());

    // Act + Assert
    should(() => descriptorHandle(987_654, bracket, fileIdentityOf)).throw(/EBADF/u);
  });

  it('should refuse a step whose folder cannot be installed as the working directory', async () => {
    // Arrange
    const here = fileIdentityOf(lstatSync('.', { bigint: true }));
    const real = loadDirectorySyscalls();
    const bracket = new DescriptorBracket(
      { fchdir: () => -1, currentDirectory: () => real.currentDirectory() },
      loadLinkSyscall(),
    );

    // Act + Assert
    should(() => bracket.run(0, here, () => undefined)).throw(/could not be installed as the working directory/u);
  });

  it('should fall back, and say why, when the C calls cannot be loaded', () => {
    // Act
    const disk = new NodeGuardDisk('calls', '/etc/group', '/proc/self/fd', () => {
      throw new Error('libSystem would not load');
    });

    // Assert — reached by path from here on, and the reason travels with every refusal.
    should(disk.descriptorCallsUnavailable).equal('libSystem would not load');
    should(disk.missingDescriptorPaths).be.false();
  });
});
