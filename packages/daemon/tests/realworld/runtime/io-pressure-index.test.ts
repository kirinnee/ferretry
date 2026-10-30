/**
 * THE DAEMON MUST NOT FREEZE WHEN THE DISK IS SATURATED.
 *
 * On the owner's EC2 box (fyd 4.101.0, 2026-10-29) other jobs held the disk at 46% "full" IO pressure and
 * the daemon's event loop stalled for 5.0, 15.3, 38.3 and 19.1 s — the app, the tunnel and the CLI hung
 * with it. The sampled stacks were SQLite: `run ← transaction ← replaceSession ← applySource`. A commit
 * to the session index ran on the event loop, and SQLite's checkpoint after it `fsync`s the log and the
 * database; on that disk the `fsync` took seconds. Reproduced on a real disk under `dd` write pressure:
 * one index write held the loop for 1,088 ms, and none did once automatic checkpoints were off.
 *
 * This holds the fix with a disk that is slow on cue: every commit blocks its thread for {@link COMMIT_MS},
 * the way that `fsync` did. The first test proves the harness reproduces the freeze — the old arrangement,
 * a commit on the main thread, stalls the loop for the whole commit. The second runs the daemon's real
 * storage, whose index is read from memory and written by its own thread over the same slow disk, and
 * holds the loop and an HTTP health check under {@link BUDGET_MS} while that disk crawls.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import {
  BunSqliteIndex,
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  InlineIndexFile,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
  WorkerIndexFile,
} from '../../../src/adapters/index.ts';
import type { HostedWorker } from '../../../src/adapters/runtime/bundled-worker-host.ts';
import type { IndexWriterRequest, IndexWriterResponse } from '../../../src/adapters/storage/index-writer-program.ts';
import { createFoundationPaths, type EventPointer, parseSessionId, resolveStateHome } from '../../../src/lib/index.ts';
import { SlowCommitDatabase } from '../../integration/support/slow-sqlite.ts';

/** What one commit costs on the saturated disk: a second and a half, inside what was measured. */
const COMMIT_MS = 1_500;
/** The daemon's ceiling for any one stall under IO pressure (docs/performance.md). */
const BUDGET_MS = 200;
const SLOW_WRITER = resolve(import.meta.dir, '../../integration/support/slow-index-writer.worker.ts');

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-io-pressure-'));
  homes.add(home);
  return home;
}

interface Responsiveness {
  /** The longest the event loop went without running a 10 ms timer, beyond its period. */
  readonly maxLoopLagMs: number;
  /** The slowest answer to `GET /health` from a server on this event loop. */
  readonly worstHealthMs: number;
  readonly healthChecks: number;
}

/** Runs `work` while measuring the loop's lateness and a health route's latency on the same loop. */
async function responsivenessDuring(work: (health: string) => Promise<void>): Promise<Responsiveness> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  let maxLoopLagMs = 0;
  let last = performance.now();
  const meter = setInterval(() => {
    const now = performance.now();
    maxLoopLagMs = Math.max(maxLoopLagMs, now - last - 10);
    last = now;
  }, 10);
  let worstHealthMs = 0;
  let healthChecks = 0;
  let done = false;
  const url = `http://127.0.0.1:${String(server.port)}/health`;
  const health = (async () => {
    while (!done) {
      const started = performance.now();
      await (await fetch(url)).text();
      worstHealthMs = Math.max(worstHealthMs, performance.now() - started);
      healthChecks += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  try {
    await work(url);
  } finally {
    done = true;
    await health;
    clearInterval(meter);
    await server.stop(true);
  }
  return { maxLoopLagMs, worstHealthMs, healthChecks };
}

const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('the session index on a saturated disk', () => {
  it('should reproduce the freeze: a commit on the event loop stalls it for the whole commit', async () => {
    // Arrange — the arrangement before the fix: the index's own connection, committing on this thread.
    const home = await temporaryHome();
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
    const fileSystem = new StateFileSystem(paths);
    await fileSystem.ensureDirectory(paths.home, 0o700);
    await (await new BunSqliteIndexFactory().open(paths, fileSystem)).close();
    const database = new SlowCommitDatabase(paths.sessionIndex, COMMIT_MS);
    database.exec('PRAGMA foreign_keys = ON');
    const index = new BunSqliteIndex(database);
    const id = parseSessionId('busy-session');
    const pointer = (sequence: number): EventPointer => ({
      sessionId: id,
      sequence,
      time: new Date(Date.UTC(2026, 9, 29, 6, 9, sequence)).toISOString(),
      type: 'session.output',
      byteOffset: sequence * 100,
      byteLength: 100,
    });

    // Act — a health check asked just before the write, as a phone's would be.
    let healthMs = 0;
    const measured = await responsivenessDuring(async url => {
      await pause(50);
      const asked = performance.now();
      const answered = fetch(url)
        .then(response => response.text())
        .then(() => {
          healthMs = performance.now() - asked;
        });
      index.replaceSession({ id, lastSequence: 1, journalLine: 2, journal: null }, [pointer(1)]);
      await answered;
    });
    await index.close();

    // Assert
    should(measured.maxLoopLagMs).be.aboveOrEqual(COMMIT_MS * 0.9);
    should(healthMs).be.aboveOrEqual(COMMIT_MS * 0.9);
  });

  it(`should keep the event loop and the health route under ${String(BUDGET_MS)} ms while the index writer crawls`, async () => {
    // Arrange — the daemon's real storage; only the disk under the writer thread is slow.
    process.env.SLOW_COMMIT_MS = String(COMMIT_MS);
    const home = await temporaryHome();
    const factory = new DaemonStorageFactory(
      new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
      new StateFileSystemFactory(),
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(
        {
          create: file =>
            new WorkerIndexFile(file, new InlineIndexFile(file), {
              spawn: () =>
                new Worker(SLOW_WRITER, { type: 'module' }) as unknown as HostedWorker<
                  IndexWriterRequest,
                  IndexWriterResponse
                >,
            }),
        },
        { batchMs: 50 },
      ),
      new SystemClock(),
      () => new KeyedSerialExecutor(),
    );
    const opened = await factory.open();
    const sessions = ['alpha', 'beta', 'gamma'].map(parseSessionId);

    // Act — a busy fleet: every session appending for two and a half seconds, and the index read throughout.
    let appended = 0;
    let indexedDuring = 0;
    const measured = await responsivenessDuring(async () => {
      const deadline = performance.now() + 2_500;
      while (performance.now() < deadline) {
        for (const id of sessions) {
          await opened.storage.append(id, 'session.output', { line: appended });
          appended += 1;
        }
        indexedDuring = (await opened.storage.tailEvents()).length;
        await pause(20);
      }
    });
    await opened.storage.close();
    delete process.env.SLOW_COMMIT_MS;
    const reopened = await factory.open();
    const persisted = (await reopened.storage.tailEvents()).length;
    await reopened.storage.close();

    // Assert — the reads saw every write at once, the file caught up by close, and nothing stalled.
    should(appended).be.above(20);
    should(indexedDuring).equal(appended);
    should(persisted).equal(appended);
    should(measured.healthChecks).be.above(20);
    should(measured.maxLoopLagMs).be.below(BUDGET_MS);
    should(measured.worstHealthMs).be.below(BUDGET_MS);
  });
});
