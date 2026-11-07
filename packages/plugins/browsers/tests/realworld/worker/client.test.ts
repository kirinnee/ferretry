// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { BrowserWorkerClient } from '../../../daemon/worker/client.ts';
import { threadWorkers } from '../../support/thread-workers.ts';
import { wallClock } from '../../support/wall-clock.ts';

const THREADS = threadWorkers(new URL('../../integration/worker/fixtures/fake-worker.mjs', import.meta.url));

const started: BrowserWorkerClient[] = [];

afterEach(async () => {
  // Never leave a thread behind: these are real worker threads.
  await Promise.all(started.splice(0).map(client => client.close().catch(() => undefined)));
});

describe('browser worker client — lifecycle', () => {
  it('should bound the whole shutdown by the shutdown timeout, not the request timeout', async () => {
    // Arrange: a worker that never answers 'close', with a request budget far larger than shutdown.
    const client = await BrowserWorkerClient.connect({
      start: THREADS.start,
      clock: wallClock(),
      endpoint: 'stubborn-close',
      readyTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 150,
      frameIntervalMs: 0,
    });
    started.push(client);
    const begun = Bun.nanoseconds();

    // Act
    await client.close();

    // Assert: charging the request timeout first would hold up daemon shutdown for 30s per session.
    const elapsedMs = (Bun.nanoseconds() - begun) / 1_000_000;
    should(elapsedMs).be.below(3_000);
  });
});
