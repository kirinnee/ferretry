import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetScaffolder } from '../../src/adapters/file-scaffolder.ts';
import { type FleetScaffold, FleetScaffoldPartialError } from '../../src/lib/scaffold.ts';

const scaffoldFor = (root: string): FleetScaffold => ({
  directories: [root, path.join(root, 'bin'), path.join(root, 'assets')],
  directoryMode: 0o700,
  files: [
    { path: path.join(root, 'config.yaml'), content: 'agents: []\n', mode: 0o600 },
    { path: path.join(root, 'assets', 'README.md'), content: '# assets\n', mode: 0o600 },
  ],
  pathEntry: `export PATH="${path.join(root, 'bin')}:$PATH"`,
});

const withTemporaryFleet = async (run: (root: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-scaffold-'));
  const root = path.join(directory, 'fleet');
  try {
    await run(root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('FileFleetScaffolder', () => {
  it('should refuse to be built without a root to be bounded by', () => {
    // Act
    const act = (): unknown => new FileFleetScaffolder([]);

    // Assert
    should(act).throw(/at least one allowed fleet root/u);
  });

  it('should create every directory and seed every file on a fresh host', async () => {
    await withTemporaryFleet(async root => {
      // Arrange
      const scaffold = scaffoldFor(root);

      // Act
      const actual = await new FileFleetScaffolder([root]).scaffold(scaffold);

      // Assert
      should(actual.created).deepEqual([path.join(root, 'config.yaml'), path.join(root, 'assets', 'README.md')]);
      should(actual.kept).be.empty();
      should(actual.pathEntry).equal(scaffold.pathEntry);
      should(await readFile(path.join(root, 'config.yaml'), 'utf8')).equal('agents: []\n');
      should((await stat(path.join(root, 'bin'))).isDirectory()).be.true();
    });
  });

  it('should write private files even under a permissive umask', async () => {
    await withTemporaryFleet(async root => {
      // Act
      await new FileFleetScaffolder([root]).scaffold(scaffoldFor(root));

      // Assert — `wx` honours the umask, so the mode is set explicitly afterwards.
      should((await stat(path.join(root, 'config.yaml'))).mode & 0o777).equal(0o600);
    });
  });

  it('should leave a file somebody has already edited exactly as it found it', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — a host that already has a fleet, with an edited configuration.
      const subject = new FileFleetScaffolder([root]);
      await subject.scaffold(scaffoldFor(root));
      await Bun.write(path.join(root, 'config.yaml'), 'agents: [] # mine\n');

      // Act
      const actual = await subject.scaffold(scaffoldFor(root));

      // Assert
      should(actual.created).be.empty();
      should(actual.kept).have.length(2);
      should(await readFile(path.join(root, 'config.yaml'), 'utf8')).equal('agents: [] # mine\n');
    });
  });

  it('should fill in only what a newer release added', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — the earlier release seeded the configuration but not the README.
      const subject = new FileFleetScaffolder([root]);
      const earlier = scaffoldFor(root);
      await subject.scaffold({ ...earlier, files: earlier.files.slice(0, 1) });

      // Act
      const actual = await subject.scaffold(earlier);

      // Assert
      should(actual.created).deepEqual([path.join(root, 'assets', 'README.md')]);
      should(actual.kept).deepEqual([path.join(root, 'config.yaml')]);
    });
  });

  it('should refuse a file outside the roots it was given', async () => {
    await withTemporaryFleet(async root => {
      // Arrange
      const scaffold = scaffoldFor(root);
      const escaping: FleetScaffold = {
        ...scaffold,
        files: [{ path: path.join(root, '..', 'escaped.yaml'), content: 'x\n', mode: 0o600 }],
      };

      // Act
      const act = async (): Promise<unknown> => await new FileFleetScaffolder([root]).scaffold(escaping);

      // Assert
      await should(act()).be.rejectedWith(/refusing to write outside configured fleet roots/u);
    });
  });

  it('should refuse a directory outside the roots it was given', async () => {
    await withTemporaryFleet(async root => {
      // Arrange
      const escaping: FleetScaffold = { ...scaffoldFor(root), directories: [path.join(root, '..', 'elsewhere')] };

      // Act
      const act = async (): Promise<unknown> => await new FileFleetScaffolder([root]).scaffold(escaping);

      // Assert
      await should(act()).be.rejectedWith(/refusing to write outside configured fleet roots/u);
    });
  });

  it('should name exactly what it kept, what it created and where it stopped', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — one starter already exists (so it is KEPT), the next lands (CREATED), and a third
      // cannot be written because a directory occupies its name. Preparing a host has no undo, so
      // all three facts are a real state somebody is left in and all three are reported.
      const subject = new FileFleetScaffolder([root]);
      const scaffold = scaffoldFor(root);
      const third = path.join(root, 'assets', 'STARTER.md');
      await mkdir(third, { recursive: true });
      await writeFile(path.join(root, 'config.yaml'), 'agents: [] # mine already\n');
      const blocked: FleetScaffold = {
        ...scaffold,
        files: [...scaffold.files, { path: third, content: 'third\n', mode: 0o600 }],
      };

      // Act
      let failure: FleetScaffoldPartialError | undefined;
      try {
        await subject.scaffold(blocked);
      } catch (error) {
        failure = error as FleetScaffoldPartialError;
      }

      // Assert — exact arrays, not a bare error that implies nothing happened.
      should(failure).be.instanceof(FleetScaffoldPartialError);
      should(failure?.failedPath).equal(third);
      should(failure?.cause).match({
        message: `${third} exists but is not a file, so the fleet cannot be prepared here`,
      });
      should(failure?.progress.kept).deepEqual([path.join(root, 'config.yaml')]);
      should(failure?.progress.created).deepEqual([path.join(root, 'assets', 'README.md')]);
      should(failure?.progress.directories).deepEqual([root, path.join(root, 'bin'), path.join(root, 'assets')]);
      // The kept file is untouched and the created one really is there.
      should(await readFile(path.join(root, 'config.yaml'), 'utf8')).equal('agents: [] # mine already\n');
      should(await readFile(path.join(root, 'assets', 'README.md'), 'utf8')).equal('# assets\n');
    });
  });

  it('should name a file it published even when sealing its mode then fails', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — the write succeeds and the chmod that follows does not. The file is on the host
      // either way, so a report that omitted it would send somebody looking for something already
      // there. This is why publication is recorded from inside, before the fallible step.
      const subject = new FileFleetScaffolder([root]);
      const scaffold = scaffoldFor(root);
      const failing = new Proxy(subject, {
        get(target, property, receiver) {
          if (property !== 'writeIfAbsent') return Reflect.get(target, property, receiver);
          return async (destination: string, content: string, mode: number, onCreated: () => void) => {
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, content, { flag: 'wx', mode });
            onCreated();
            throw new Error('the mode could not be set');
          };
        },
      });

      // Act
      let failure: FleetScaffoldPartialError | undefined;
      try {
        await failing.scaffold(scaffold);
      } catch (error) {
        failure = error as FleetScaffoldPartialError;
      }

      // Assert
      should(failure).be.instanceof(FleetScaffoldPartialError);
      should(failure?.failedPath).equal(path.join(root, 'config.yaml'));
      should(failure?.progress.created).deepEqual([path.join(root, 'config.yaml')]);
      should(await readFile(path.join(root, 'config.yaml'), 'utf8')).equal('agents: []\n');
    });
  });

  it('should finish what an interrupted preparation left, keeping everything already there', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — the first pass stops part-way.
      const subject = new FileFleetScaffolder([root]);
      const scaffold = scaffoldFor(root);
      const blocker = path.join(root, 'assets', 'README.md');
      await should(subject.scaffold({ ...scaffold, directories: [...scaffold.directories, blocker] })).be.rejected();
      await rm(blocker, { recursive: true, force: true });

      // Act — running it again is the documented recovery.
      const actual = await subject.scaffold(scaffold);

      // Assert — absence is still the kernel's decision, so what landed first time is kept.
      should(actual.kept).deepEqual([path.join(root, 'config.yaml')]);
      should(actual.created).deepEqual([blocker]);
    });
  });

  it('should refuse damaged state rather than reporting it as a file somebody edited', async () => {
    await withTemporaryFleet(async root => {
      // Arrange — a directory where the scaffold expects a file. It reports EEXIST like an edited
      // file would, and "kept, left as it is" would be a fleet that is not set up saying it is.
      const subject = new FileFleetScaffolder([root]);
      const scaffold = scaffoldFor(root);
      const asDirectory: FleetScaffold = {
        ...scaffold,
        directories: [...scaffold.directories, path.join(root, 'config.yaml')],
      };

      // Act
      const act = async (): Promise<unknown> => await subject.scaffold(asDirectory);

      // Assert
      await should(act()).be.rejectedWith(/exists but is not a file/u);
    });
  });
});
