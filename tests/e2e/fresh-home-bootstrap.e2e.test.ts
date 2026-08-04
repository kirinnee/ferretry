import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
 * Points the CLI at the bootstrap-only stand-in and leaves this run's leased port where it looks.
 *
 * The stand-in runs where it lives: it imports the daemon package by relative path, so a copy in the
 * fixture's bin directory would not resolve. `fy daemon start` hands its child only `FY_HOME` and
 * `PATH`, so the port travels in a file in the bin directory — the first `PATH` entry.
 */
async function installStandInDaemon(environment: E2eEnvironment): Promise<string> {
  const executable = await environment.assertSafePath(
    join(environment.repositoryRoot, 'scripts', 'test', 'bootstrap-only-fyd.ts'),
    'stand-in daemon',
  );
  await environment.releasePorts();
  await writeFile(join(environment.paths.bin, `${DAEMON_NAME}.port`), `${String(environment.ports.api)}\n`, 'utf8');
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

  it('should start again on a home it has already initialized', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const daemonBinary = await installStandInDaemon(environment);
      const environmentVariables = connection(environment, daemonBinary);
      const first = await environment.runFy(['daemon', 'start'], environmentVariables);
      const stopped = await environment.runFy(['daemon', 'stop'], environmentVariables);

      try {
        // Act — a second start reads a home carrying a marker, a lock and its own log directory.
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
