import { describe, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { type BundledWorkerName, bundledWorkerUrl } from '../../../src/adapters/runtime/bundled-worker.ts';
import { LoadSafeWorker } from '../../../src/adapters/runtime/load-safe-worker.ts';

/** A worker program from source text, so a case can say exactly how its load goes. */
function program(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
}

/** The lifecycle events a worker dispatched, in order, settled when it closed. */
function lifecycle(worker: Worker): { readonly events: string[]; readonly closed: Promise<void> } {
  const events: string[] = [];
  for (const type of ['open', 'error'] as const) worker.addEventListener(type, () => events.push(type));
  const closed = new Promise<void>(resolve =>
    worker.addEventListener('close', () => {
      events.push('close');
      resolve();
    }),
  );
  return { events, closed };
}

describe('LoadSafeWorker', () => {
  it('should end a thread told to stop before it loaded only once it has', async () => {
    // Arrange
    const worker = new LoadSafeWorker(program('postMessage("loaded");'));
    const seen = lifecycle(worker);

    // Act
    worker.terminate();
    await seen.closed;

    // Assert — a plain Worker would close without ever opening.
    should(seen.events).eql(['open', 'close']);
  });

  it('should deliver what was posted while it loaded, in order, once it opens', async () => {
    // Arrange
    const worker = new LoadSafeWorker(program('onmessage = event => postMessage(event.data);'));
    const echoed: unknown[] = [];
    const both = new Promise<void>(resolve => {
      worker.onmessage = event => {
        echoed.push(event.data);
        if (echoed.length === 2) resolve();
      };
    });

    // Act
    worker.postMessage('first');
    worker.postMessage({ second: true });
    await both;
    worker.terminate();

    // Assert
    should(echoed).eql(['first', { second: true }]);
  });

  it('should hand a thread ended while it loaded nothing that was posted to it', async () => {
    // Arrange — the thread would leave a file behind for any message it got.
    const scratch = await mkdtemp(join(tmpdir(), 'fy-load-safe-'));
    const mark = join(scratch, 'ran');
    try {
      const worker = new LoadSafeWorker(
        program(`onmessage = () => require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'ran');`),
      );
      const seen = lifecycle(worker);

      // Act
      worker.postMessage('do the work');
      worker.terminate();
      // A stopping daemon is busy: the thread loads, and would run what it was sent, before `open` is heard.
      Bun.sleepSync(300);
      await seen.closed;

      // Assert
      should(seen.events).eql(['open', 'close']);
      should(existsSync(mark)).be.false();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('should end a thread that has loaded at once', async () => {
    // Arrange
    const worker = new LoadSafeWorker(program('setInterval(() => {}, 1000);'));
    const seen = lifecycle(worker);
    await new Promise<void>(resolve => worker.addEventListener('open', () => resolve(), { once: true }));

    // Act
    worker.terminate();
    await seen.closed;

    // Assert
    should(seen.events).eql(['open', 'close']);
  });

  it('should end a thread whose program fails to load, without waiting for an open that never comes', async () => {
    // Arrange
    const worker = new LoadSafeWorker(program('throw new Error("broken on load");'));
    const seen = lifecycle(worker);

    // Act
    worker.terminate();
    await seen.closed;

    // Assert
    should(seen.events).containEql('error');
    should(seen.events).not.containEql('open');
  });

  it('should survive ending every bundled worker while it is still loading', async () => {
    // Arrange — the shape that crashed Bun 1.3: a boot starts its threads and is stopped at once.
    const names: readonly BundledWorkerName[] = [
      'session',
      'housekeeping',
      'analytics-fold',
      'analytics-index',
      'pdf-decrypt',
    ];
    const closed: Promise<void>[] = [];

    // Act
    for (let round = 0; round < 10; round++) {
      const workers = names.map(name => new LoadSafeWorker(bundledWorkerUrl(name), { type: 'module' }));
      closed.push(...workers.map(worker => lifecycle(worker).closed));
      await Bun.sleep(round * 8);
      for (const worker of workers) worker.terminate();
    }

    // Assert — reaching here at all is the proof: the crash took the whole test process with it.
    await Promise.all(closed);
    should(closed.length).equal(names.length * 10);
  }, 120_000);
});
