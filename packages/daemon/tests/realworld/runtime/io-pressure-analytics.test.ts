/**
 * THE ANALYTICS INDEX MUST NOT FREEZE THE DAEMON WHEN THE DISK IS SATURATED.
 *
 * the realworld tier caught a 307 ms stall 2.75 s into boot whose stacks were
 * `upsert (sqlite-analytics-store.ts) ← sweep (analytics/ingestion.ts)`: the ingestion sweep wrote its
 * rows to `analytics.sqlite` in one transaction on the event loop, and the commit — with the checkpoint's
 * `fsync` behind it — ran there. The same disk froze the session index for seconds (`io-pressure-index`).
 *
 * This holds the fix with a disk that is slow on cue: every commit blocks its thread for {@link COMMIT_MS}.
 * The first test proves the harness reproduces the freeze with the old arrangement, a store committing
 * on the main thread. The second runs the daemon's real analytics store — read from memory, written by
 * its own thread over the same slow disk — and holds the loop under {@link BUDGET_MS}.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import {
  BunSqliteAnalyticsStore,
  BunSqliteAnalyticsStoreFactory,
  InlineAnalyticsPersister,
  WorkerAnalyticsPersister,
} from '../../../src/adapters/analytics/index.ts';
import { StateFileSystem } from '../../../src/adapters/index.ts';
import type { HostedWorker } from '../../../src/adapters/runtime/bundled-worker-host.ts';
import type {
  AnalyticsWriterRequest,
  AnalyticsWriterResponse,
} from '../../../src/adapters/analytics/analytics-writer-program.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { refusedSession } from '../../integration/support/analytics-fixtures.ts';
import { SlowCommitDatabase } from '../../integration/support/slow-sqlite.ts';

/** What one commit costs on the saturated disk: a second and a half, inside what was measured. */
const COMMIT_MS = 1_500;
/** The daemon's ceiling for any one stall under IO pressure (docs/performance.md). */
const BUDGET_MS = 200;
/** The owner's fleet: thousands of finished sessions, ingested in a handful of sweeps. */
const ROWS = 1_500;
const SLOW_WRITER = resolve(import.meta.dir, '../../integration/support/slow-analytics-writer.worker.ts');

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function temporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-io-pressure-analytics-'));
  homes.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

const sessions = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => refusedSession(`session-${String(from + index)}`));

/** The longest the event loop went without running a 10 ms timer, beyond its period, while `work` ran. */
async function maxLoopLagDuring(work: () => Promise<void>): Promise<number> {
  let maxLoopLagMs = 0;
  let last = performance.now();
  const meter = setInterval(() => {
    const now = performance.now();
    maxLoopLagMs = Math.max(maxLoopLagMs, now - last - 10);
    last = now;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(meter);
  }
  return maxLoopLagMs;
}

const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('the analytics index on a saturated disk', () => {
  it('should reproduce the freeze: a sweep committing on the event loop stalls it for the whole commit', async () => {
    // Arrange — the arrangement before the fix: the store's own connection, committing on this thread.
    const paths = await temporaryPaths();
    const fileSystem = new StateFileSystem(paths);
    await fileSystem.ensureDirectory(paths.home, 0o700);
    await (await new BunSqliteAnalyticsStoreFactory().open(paths, fileSystem)).store.close();
    const store = new BunSqliteAnalyticsStore(new SlowCommitDatabase(paths.analyticsIndex, COMMIT_MS));

    // Act
    const lag = await maxLoopLagDuring(async () => {
      await pause(50);
      store.upsert(sessions(0, ROWS));
      await pause(20);
    });
    await store.close();

    // Assert
    should(lag).be.aboveOrEqual(COMMIT_MS * 0.9);
  });

  it(`should keep the event loop under ${String(BUDGET_MS)} ms while the analytics writer crawls`, async () => {
    // Arrange — the daemon's real store; only the disk under the writer thread is slow.
    process.env.SLOW_COMMIT_MS = String(COMMIT_MS);
    const paths = await temporaryPaths();
    const fileSystem = new StateFileSystem(paths);
    const factory = new BunSqliteAnalyticsStoreFactory(
      {
        create: (file, connection) =>
          new WorkerAnalyticsPersister(file, new InlineAnalyticsPersister(connection), {
            spawn: () =>
              new Worker(SLOW_WRITER, { type: 'module' }) as unknown as HostedWorker<
                AnalyticsWriterRequest,
                AnalyticsWriterResponse
              >,
          }),
      },
      { batchMs: 50 },
    );
    const { store } = await factory.open(paths, fileSystem);

    // Act — sweeps of sessions arriving for two and a half seconds, the index read throughout.
    let written = 0;
    const lag = await maxLoopLagDuring(async () => {
      const deadline = performance.now() + 2_500;
      while (performance.now() < deadline) {
        store.upsert(sessions(written, 100));
        written += 100;
        should(store.rows().length).equal(written);
        await pause(20);
      }
    });
    await store.close();
    delete process.env.SLOW_COMMIT_MS;
    const reopened = await factory.open(paths, fileSystem);
    const persisted = reopened.store.rows().length;
    await reopened.store.close();

    // Assert — the reads saw every write at once, the file caught up by close, and nothing stalled.
    should(written).be.above(500);
    should(persisted).equal(written);
    should(lag).be.below(BUDGET_MS);
  });
});
