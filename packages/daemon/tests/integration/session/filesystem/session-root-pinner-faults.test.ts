import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  loadDirectorySyscalls,
  NODE_PIN_FILE_CALLS,
  type PinFileCalls,
  PosixSessionRootPinner,
  ProcfsSessionRootPinner,
} from '../../../../src/adapters/session/filesystem/index.ts';
import type { FsError, WorkBudget } from '../../../../src/lib/session/filesystem/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

/**
 * What the pinners do when the kernel answers a call the way it only does inside a race.
 *
 * A name that vanishes between a listing and the `lstat` that describes it, a directory that cannot be
 * described after it was opened, a descriptor that is already closed: none of these can be provoked by a
 * test on a quiet tree, so the POSIX pinner's file calls (and the procfs pinner's `lstat`) are handed a
 * fault at exactly the call a race would break. Everything else is the real kernel.
 */

afterAll(cleanupTempDirectories);

const kernelError = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });

/** The runtime's own calls, with some replaced. */
const faulting = (faults: Partial<PinFileCalls>): PinFileCalls => ({ ...NODE_PIN_FILE_CALLS, ...faults });

async function fixture(label: string): Promise<string> {
  const root = await tempDirectory(label);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
  await writeFile(path.join(root, 'src', 'b.ts'), 'b\n');
  return root;
}

async function refusalOf(act: () => Promise<unknown>): Promise<unknown> {
  try {
    await act();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('the pinner that installs the held directory, when the kernel disagrees mid-request', () => {
  it('should give the working directory back when a bracket cannot prove it holds the directory it installed', async () => {
    // Arrange: a pin made honestly, then a runtime whose `.` starts naming some other directory.
    const root = await fixture('fault-prove');
    const elsewhere = await tempDirectory('fault-prove-elsewhere');
    let lying = false;
    const syscalls = loadDirectorySyscalls();
    const pinner = new PosixSessionRootPinner(
      () => syscalls,
      faulting({ open: (name, flags) => NODE_PIN_FILE_CALLS.open(lying && name === '.' ? elsewhere : name, flags) }),
    );
    const pinned = await pinner.pin(root);
    const before = syscalls.currentDirectory();
    lying = true;

    // Act
    const error = await refusalOf(async () => await pinned.open('src/a.ts'));
    lying = false;

    // Assert: the whole surface refuses, and the runtime is not left standing in the session's tree.
    should((error as FsError).code).equal('unsupported');
    should(syscalls.currentDirectory()).equal(before);
    await pinned.close();
  });

  it('should let a pinned object and a pinned root be closed twice', async () => {
    // Arrange
    const root = await fixture('fault-close-twice');
    const pinned = await new PosixSessionRootPinner().pin(root);
    const target = await pinned.open('src', { wantDirectory: true });

    // Act
    await target.close();
    const secondTarget = target.close();
    await pinned.close();
    const secondRoot = pinned.close();

    // Assert: a descriptor that is already closed is what the second call finds, and it is not an error.
    await should(secondTarget).be.fulfilled();
    await should(secondRoot).be.fulfilled();
  });

  it('should list an entry without its size when it vanished between the listing and its description', async () => {
    // Arrange
    const root = await fixture('fault-vanished');
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        lstat: name => {
          if (name === 'a.ts') throw kernelError('ENOENT');
          return NODE_PIN_FILE_CALLS.lstat(name);
        },
      }),
    );
    const pinned = await pinner.pin(root);
    const directory = await pinned.open('src', { wantDirectory: true });

    // Act
    const listing = await directory.list(10);
    await directory.close();
    await pinned.close();

    // Assert
    const names = listing.entries.map(entry => entry.name).sort();
    should(names).eql(['a.ts', 'b.ts']);
    should(listing.entries.find(entry => entry.name === 'a.ts')).eql({ name: 'a.ts', type: 'file' });
    should(listing.entries.find(entry => entry.name === 'b.ts')).have.property('size', 2);
  });

  it('should not hide a failure to describe an entry that is not a vanishing', async () => {
    // Arrange
    const root = await fixture('fault-describe');
    const broken = kernelError('EIO');
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        lstat: name => {
          if (name === 'a.ts') throw broken;
          return NODE_PIN_FILE_CALLS.lstat(name);
        },
      }),
    );
    const pinned = await pinner.pin(root);
    const directory = await pinned.open('src', { wantDirectory: true });

    // Act
    const error = await refusalOf(async () => await directory.list(10));
    await directory.close();
    await pinned.close();

    // Assert
    should(error).equal(broken);
  });

  it('should stop a probe between two siblings when its budget runs out between them', async () => {
    // Arrange: a budget that lets the first name in and is spent by the time the second is asked for.
    const root = await fixture('fault-budget');
    const pinned = await new PosixSessionRootPinner().pin(root);
    const probe = pinned.probe();
    let asks = 0;
    const budget: WorkBudget = {
      expired: () => {
        asks += 1;
        return asks > 1;
      },
    };

    // Act
    const kinds = await probe.classify(['src/a.ts', 'src/b.ts'], budget);
    await probe.close();
    await pinned.close();

    // Assert: the name asked for first is answered and the one after it is left for the caller to see unanswered.
    should(kinds).eql(['file']);
  });

  it('should call a directory unreadable, and close it, when it cannot be described after it was opened', async () => {
    // Arrange: every directory the probe steps into is opened, then fails its `fstat`.
    const root = await fixture('fault-fstat');
    const stepped = new Set<number>();
    const closed: number[] = [];
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        open: (name, flags) => {
          const fd = NODE_PIN_FILE_CALLS.open(name, flags);
          if (name === 'src') stepped.add(fd);
          return fd;
        },
        fstat: fd => {
          if (stepped.has(fd)) throw kernelError('EIO');
          return NODE_PIN_FILE_CALLS.fstat(fd);
        },
        close: fd => {
          closed.push(fd);
          NODE_PIN_FILE_CALLS.close(fd);
        },
      }),
    );
    const pinned = await pinner.pin(root);
    const probe = pinned.probe();

    // Act
    const kinds = await probe.classify(['src/a.ts', 'src/b.ts']);
    await probe.close();
    await pinned.close();

    // Assert: both names share the refusal, and the descriptor that could not be described was let go.
    should(kinds).eql(['unreadable', 'unreadable']);
    should([...stepped].every(fd => closed.includes(fd))).be.true();
  });

  it('should close a probe whose held directory is already closed without complaint', async () => {
    // Arrange: the descriptor the probe holds for `src` is closed behind its back, so its own close fails.
    const root = await fixture('fault-release');
    const stepped: number[] = [];
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        open: (name, flags) => {
          const fd = NODE_PIN_FILE_CALLS.open(name, flags);
          if (name === 'src') stepped.push(fd);
          return fd;
        },
        close: fd => {
          NODE_PIN_FILE_CALLS.close(fd);
          if (stepped.includes(fd)) throw kernelError('EBADF');
        },
      }),
    );
    const pinned = await pinner.pin(root);
    const probe = pinned.probe();
    await probe.classify(['src/a.ts']);

    // Act
    const closing = probe.close();
    await pinned.close();

    // Assert
    await should(closing).be.fulfilled();
  });

  it('should still name a directory a file, when what stood in its place cannot be described', async () => {
    // Arrange: a file where a directory is wanted, and an `lstat` that fails once it is asked what it is.
    const root = await fixture('fault-lstat-posix');
    const asked: string[] = [];
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        lstat: name => {
          asked.push(name);
          throw kernelError('ENOENT');
        },
      }),
    );
    const pinned = await pinner.pin(root);

    // Act
    const error = await refusalOf(async () => await pinned.open('src/a.ts/inside'));
    await pinned.close();

    // Assert: it was asked, could not say, and was not taken for a link.
    should(asked).containEql('a.ts');
    should((error as FsError).code).equal('not_a_directory');
  });

  it('should hand back, as it came, a failure to open the root that is not about the root being missing', async () => {
    // Arrange
    const root = await fixture('fault-open-root');
    const broken = kernelError('EIO');
    const pinner = new PosixSessionRootPinner(
      loadDirectorySyscalls,
      faulting({
        open: (name, flags) => {
          if (name === root) throw broken;
          return NODE_PIN_FILE_CALLS.open(name, flags);
        },
      }),
    );

    // Act
    const error = await refusalOf(async () => await pinner.pin(root));

    // Assert: not a refusal the viewer made up, so not an `FsError` either.
    should(error).equal(broken);
  });
});

describe.if(process.platform === 'linux')(
  'the pinner that names the held directory through procfs, when a swap wins',
  () => {
    it('should still name a directory a file, when what stood in its place cannot be described', async () => {
      // Arrange: a file where a directory is wanted, and an `lstat` that fails once it is asked what it is.
      const root = await fixture('fault-lstat-procfs');
      const asked: string[] = [];
      const pinner = new ProcfsSessionRootPinner(async path => {
        asked.push(String(path));
        throw kernelError('ENOENT');
      });
      const pinned = await pinner.pin(root);

      // Act
      const error = await refusalOf(async () => await pinned.open('src/a.ts/inside'));
      await pinned.close();

      // Assert: it was asked about the one component, could not say, and did not take it for a link.
      should(asked.length).equal(1);
      should(asked[0]).match(/\/a\.ts$/);
      should((error as FsError).code).equal('not_a_directory');
    });

    it.skipIf(process.getuid?.() === 0)(
      'should hand back, as it came, a failure to open the root that is not about the root being missing',
      async () => {
        // Arrange: a directory the user may not read, which no root may be pinned through.
        const parent = await tempDirectory('fault-procfs-root');
        const locked = path.join(parent, 'locked');
        await mkdir(locked);
        await chmod(locked, 0o000);

        // Act
        const error = await refusalOf(async () => await new ProcfsSessionRootPinner().pin(locked));
        await chmod(locked, 0o700);

        // Assert
        should((error as { code?: string }).code).equal('EACCES');
      },
    );
  },
);
