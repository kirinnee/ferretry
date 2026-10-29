import { describe, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import should from 'should';
import {
  bundledWorkerUrl,
  describeWorkerProbes,
  probeBundledWorker,
} from '../../../src/adapters/runtime/bundled-worker.ts';

describe('bundledWorkerUrl', () => {
  it('should name the worker program in the source tree when run from source', async () => {
    // Act
    const url = bundledWorkerUrl('pdf-decrypt');

    // Assert
    should(url).endWith('/packages/daemon/bin/pdf-decrypt.worker.ts');
    should(await Bun.file(fileURLToPath(url)).exists()).be.true();
  });

  it('should name the embedded program beside the root of a compiled binary', () => {
    // Act / Assert — every module of a compiled binary shares the entry's embedded URL.
    should(bundledWorkerUrl('pdf-decrypt', 'file:///$bunfs/root/fyd.js')).equal(
      'file:///$bunfs/root/pdf-decrypt.worker.js',
    );
  });
});

describe('describeWorkerProbes', () => {
  it('should list every ready worker, or name the first that did not start and why', () => {
    // Act / Assert
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: true }])).equal('pdf-decrypt ready');
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: false, reason: 'ModuleNotFound' }])).equal(
      '! pdf-decrypt did not start — ModuleNotFound',
    );
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: false }])).equal(
      '! pdf-decrypt did not start — no reason was given',
    );
  });
});

/** A stand-in thread that answers the probe however a case needs. */
function fakeWorker(
  answer: (worker: {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
  }) => void,
) {
  const worker = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminated: false,
    postMessage: () => queueMicrotask(() => answer(worker)),
    terminate: () => {
      worker.terminated = true;
    },
  };
  return worker;
}

describe('probeBundledWorker', () => {
  it('should start the real analytics worker and hear it answer', async () => {
    should(await probeBundledWorker('analytics-fold')).deepEqual({ name: 'analytics-fold', ready: true });
  });

  it('should start the real analytics index writer and hear it answer', async () => {
    should(await probeBundledWorker('analytics-index')).deepEqual({ name: 'analytics-index', ready: true });
  });

  it('should start the real session worker and hear it answer', async () => {
    should(await probeBundledWorker('session')).deepEqual({ name: 'session', ready: true });
  });

  it('should start the real housekeeping worker and hear it answer', async () => {
    should(await probeBundledWorker('housekeeping')).deepEqual({ name: 'housekeeping', ready: true });
  });

  it('should report every way a worker can fail the probe, and end it each time', async () => {
    // Arrange
    const cases = [
      fakeWorker(worker => worker.onmessage?.({ data: { ok: false, probe: true } } as MessageEvent<unknown>)),
      fakeWorker(worker => worker.onmessage?.({ data: null } as MessageEvent<unknown>)),
      fakeWorker(worker => worker.onerror?.({ message: 'ModuleNotFound' } as ErrorEvent)),
      fakeWorker(worker => worker.onerror?.(undefined as unknown as ErrorEvent)),
      fakeWorker(() => undefined),
    ];

    // Act
    const reports = [];
    for (const worker of cases)
      reports.push(
        await probeBundledWorker('analytics-fold', { timeoutMs: 5, spawn: () => worker as unknown as Worker }),
      );
    const uncreatable = await probeBundledWorker('analytics-fold', {
      spawn: () => {
        throw new Error('no such program');
      },
    });

    // Assert
    should(reports.map(report => report.reason)).deepEqual([
      'it started but did not answer the probe',
      'it started but did not answer the probe',
      'it failed: ModuleNotFound',
      'it failed: no detail',
      'no answer within 5 ms',
    ]);
    should(cases.every(worker => worker.terminated)).be.true();
    should(uncreatable).deepEqual({
      name: 'analytics-fold',
      ready: false,
      reason: 'it could not be created: no such program',
    });
  });
});
