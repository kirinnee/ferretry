import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetScaffolder } from '../../src/adapters/file-scaffolder.ts';
import type { FleetScaffold } from '../../src/lib/scaffold.ts';

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
