import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * The first-run journey: `fy daemon start` on a machine that has never run this product.
 *
 * This is the one bug class neither package can catch alone. `decideLayout` is a pure function that
 * was always correct on the inputs it was given, and the CLI's supervisor always created the log
 * directory it was told to; the defect lived entirely in the seam, where the CLI's `logs/` reached a
 * layout model that had never been told the directory was ours. So the test crosses the seam: the
 * shipped `fy` binary drives the real start path, and the executable it launches runs the daemon's
 * real `DaemonStorageFactory` against the real state home.
 *
 * Unlike `daemon-control.e2e.test.ts`, this DOES drive `start` and `stop` — safely, because the state
 * home is a temp directory, no service manager is installed in it (so the direct supervisor owns the
 * daemon), and the process launched is a stand-in that binds this run's leased loopback port instead
 * of the daemon's fixed default.
 */

const DAEMON_NAME = 'fyd';
const REFUSAL = 'is non-empty but has no layout-version marker';

/**
 * Installs the bootstrap-only stand-in and leaves its relocatable sidecars where the child looks.
 *
 * `fy daemon start` hands its child only `FY_HOME` and `PATH`, so both the leased port and repository
 * module root travel in files in the bin directory — the first `PATH` entry. The executable is copied
 * here and again into the snapshot store, proving neither location-relative import can sneak back in.
 */
async function installStandInDaemon(environment: E2eEnvironment): Promise<string> {
  const source = await environment.assertSafePath(
    join(environment.repositoryRoot, 'scripts', 'test', 'bootstrap-only-fyd.ts'),
    'stand-in daemon source',
  );
  const executable = await environment.assertSafePath(join(environment.paths.bin, DAEMON_NAME), 'stand-in daemon');
  await environment.releasePorts();
  await copyFile(source, executable);
  await chmod(executable, 0o700);
  await writeFile(join(environment.paths.bin, `${DAEMON_NAME}.port`), `${String(environment.ports.api)}\n`, 'utf8');
  await writeFile(
    join(environment.paths.bin, `${DAEMON_NAME}.repository-root`),
    `${environment.repositoryRoot}\n`,
    'utf8',
  );
  return executable;
}

function connection(environment: E2eEnvironment, daemonBinary: string): Record<string, string> {
  return {
    FY_URL: environment.httpUrl(),
    FY_TOKEN: 'e2e-token',
    FY_DAEMON_BIN: daemonBinary,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readLog(environment: E2eEnvironment): Promise<string> {
  return await readFile(join(environment.paths.fyHome, 'logs', `${DAEMON_NAME}.log`), 'utf8');
}

describe('first-run daemon bootstrap', () => {
  it('should start a daemon against a state home that does not exist yet', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — a genuinely clean machine: no state home at all, not merely an empty one.
      const daemonBinary = await installStandInDaemon(environment);
      await rm(environment.paths.fyHome, { recursive: true, force: true });

      try {
        // Act — `start` creates `logs/` for the log it configured, THEN launches the daemon into it.
        const actual = await environment.runFy(['daemon', 'start'], connection(environment, daemonBinary));

        // Assert — before the fix this failed with `fyd started but its process exited during
        // startup`, and the log inside the very directory that caused it read
        // `fyd: state home … is non-empty but has no layout-version marker`.
        should(actual.err).not.containEql(REFUSAL);
        should(actual.out + actual.err).containEql(`${DAEMON_NAME} ready (pid `);
        should(actual.code).equal(0);
        should(await readLog(environment)).not.containEql(REFUSAL);
        should(await exists(join(environment.paths.fyHome, 'layout-version'))).be.true();
        should(await exists(join(environment.paths.fyHome, 'logs'))).be.true();
      } finally {
        await environment.runFy(['daemon', 'stop'], connection(environment, daemonBinary));
      }
    });
  });

  it('should start when logs already holds the log of a previous failed attempt', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — exactly the state the reporting user was left in: `rm -rf` did not help them,
      // because the next start recreated `logs/` before the daemon ever looked at the home.
      const daemonBinary = await installStandInDaemon(environment);
      const logDirectory = join(environment.paths.fyHome, 'logs');
      await mkdir(logDirectory, { recursive: true });
      await writeFile(
        join(logDirectory, `${DAEMON_NAME}.log`),
        `${DAEMON_NAME}: state home ${environment.paths.fyHome} ${REFUSAL}\n`,
        'utf8',
      );

      try {
        // Act
        const actual = await environment.runFy(['daemon', 'start'], connection(environment, daemonBinary));

        // Assert — the stale refusal is still in the file; what matters is that this start succeeded.
        should(actual.out + actual.err).containEql(`${DAEMON_NAME} ready (pid `);
        should(actual.code).equal(0);
        should(await exists(join(environment.paths.fyHome, 'layout-version'))).be.true();
      } finally {
        await environment.runFy(['daemon', 'stop'], connection(environment, daemonBinary));
      }
    });
  });

  it('should boot after the fleet was provisioned first, which is the order the reporter used', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — the reported P0, through the compiled binaries. `fy fleet init` wrote `fleet/**`
      // and claimed nothing, so the daemon's next boot met a non-empty unmarked home and refused it
      // FOREVER; the only move the shipped product left was `rm -rf` of the home just provisioned.
      // Reverse the two commands and it worked, so a fresh install came up or did not depending on
      // which one a person happened to type first.
      //
      // The integration test in `packages/cli/tests/integration/daemon/fleet-home-claim.test.ts`
      // carries the actual guard, because no CI job runs this tier. This one proves the same journey
      // through the shipped executables.
      const daemonBinary = await installStandInDaemon(environment);
      const environmentVariables = connection(environment, daemonBinary);
      await rm(environment.paths.fyHome, { recursive: true, force: true });

      try {
        // Act
        const initialized = await environment.runFy(['fleet', 'init', '--first-account=claude'], environmentVariables);
        const applied = await environment.runFy(['fleet', 'apply'], environmentVariables);
        const started = await environment.runFy(['daemon', 'start'], environmentVariables);

        // Assert — the marker exists because `fleet init` claimed the home, before any fleet file.
        should(initialized.code).equal(0);
        should(applied.code).equal(0);
        should(await exists(join(environment.paths.fyHome, 'layout-version'))).be.true();
        should(started.out + started.err).containEql(`${DAEMON_NAME} ready (pid `);
        should(started.code).equal(0);
        should(await readLog(environment)).not.containEql(REFUSAL);
      } finally {
        await environment.runFy(['daemon', 'stop'], environmentVariables);
      }
    });
  });

  it('should repair a home provisioned before layout claims existed', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — every owner on a release before this one is in exactly this state, so this is the
      // upgrade path rather than a nicety. The fleet content is arranged by hand because that IS the
      // legacy arrangement; the marker is the one thing a test may never write.
      const daemonBinary = await installStandInDaemon(environment);
      const environmentVariables = connection(environment, daemonBinary);
      await rm(environment.paths.fyHome, { recursive: true, force: true });
      await mkdir(join(environment.paths.fyHome, 'fleet', 'bin'), { recursive: true });
      await writeFile(join(environment.paths.fyHome, 'fleet', 'config.yaml'), 'version: 1\n', 'utf8');

      try {
        // Act
        const adopted = await environment.runFy(['daemon', 'adopt'], environmentVariables);
        const started = await environment.runFy(['daemon', 'start'], environmentVariables);

        // Assert — the adopt reports what it took over before taking it.
        should(adopted.code).equal(0);
        should(adopted.out).containEql('fleet');
        should(await exists(join(environment.paths.fyHome, 'layout-version'))).be.true();
        should(started.out + started.err).containEql(`${DAEMON_NAME} ready (pid `);
        should(started.code).equal(0);
      } finally {
        await environment.runFy(['daemon', 'stop'], environmentVariables);
      }
    });
  });

  it('should refuse a directory that is somebody else s, from both commands', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange — the guard must still bite through the shipped binaries: before this change
      // `fy fleet init` would provision a fleet straight into a person's documents folder.
      const daemonBinary = await installStandInDaemon(environment);
      const environmentVariables = connection(environment, daemonBinary);
      await rm(environment.paths.fyHome, { recursive: true, force: true });
      await mkdir(join(environment.paths.fyHome, 'Documents'), { recursive: true });
      await writeFile(join(environment.paths.fyHome, 'notes.txt'), 'not a state home\n', 'utf8');

      // Act
      const initialized = await environment.runFy(['fleet', 'init', '--first-account=claude'], environmentVariables);
      const adopted = await environment.runFy(['daemon', 'adopt'], environmentVariables);

      // Assert — both refuse, both name what they found, and neither writes a marker into it.
      should(initialized.code).not.equal(0);
      should(initialized.err).containEql('notes.txt');
      should(adopted.code).not.equal(0);
      should(adopted.err).containEql('Documents');
      should(await exists(join(environment.paths.fyHome, 'layout-version'))).be.false();
    });
  });

  it('should start again on a home it has already initialized', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const daemonBinary = await installStandInDaemon(environment);
      const environmentVariables = connection(environment, daemonBinary);
      const first = await environment.runFy(['daemon', 'start'], environmentVariables);
      const stopped = await environment.runFy(['daemon', 'stop'], environmentVariables);
      await rm(daemonBinary);

      try {
        // Act — the live source is gone; the second start must use the retained promoted snapshot.
        const actual = await environment.runFy(['daemon', 'start'], environmentVariables);

        // Assert
        should(first.code).equal(0);
        should(stopped.code).equal(0);
        should(actual.out + actual.err).containEql(`${DAEMON_NAME} ready (pid `);
        should(actual.code).equal(0);
        should(await readLog(environment)).not.containEql(REFUSAL);
      } finally {
        await environment.runFy(['daemon', 'stop'], environmentVariables);
      }
    });
  });
});
