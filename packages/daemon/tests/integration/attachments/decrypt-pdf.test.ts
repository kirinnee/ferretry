import { describe, it } from 'bun:test';
import should from 'should';
import { decryptPdfInMemory, probePdfDecryptWorker } from '../../../src/adapters/attachments/index.ts';
import { PdfDecryptError } from '../../../src/lib/attachments/index.ts';

type WorkerOutcome =
  | { readonly kind: 'message'; readonly data: unknown }
  | { readonly kind: 'error' }
  | { readonly kind: 'silent' }
  | { readonly kind: 'unconstructable' };

class FakeWorker {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  requests: unknown[] = [];

  constructor(private readonly outcome: WorkerOutcome) {}

  postMessage(request: unknown): void {
    this.requests.push(request);
    queueMicrotask(() => {
      if (this.outcome.kind === 'message') this.onmessage?.({ data: this.outcome.data });
      if (this.outcome.kind === 'error') this.onerror?.();
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Runs `run` with a `spawn` that starts a fake thread answering `outcome`, and the first such thread. */
async function withWorker<T>(
  outcome: WorkerOutcome,
  run: (worker: () => FakeWorker, spawn: () => Worker) => Promise<T>,
): Promise<T> {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    if (outcome.kind === 'unconstructable') throw new Error('no such worker program');
    const worker = new FakeWorker(outcome);
    workers.push(worker);
    return worker as unknown as Worker;
  };
  return await run(() => {
    const worker = workers[0];
    if (worker === undefined) throw new Error('the decryptor did not construct a worker');
    return worker;
  }, spawn);
}

describe('decryptPdfInMemory', () => {
  it('returns worker output and terminates the disposable worker', async () => {
    const output = new Uint8Array([1, 2, 3]).buffer;
    await withWorker({ kind: 'message', data: { ok: true, output } }, async (worker, spawn) => {
      const actual = await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn });

      should([...actual]).deepEqual([1, 2, 3]);
      should(worker().terminated).be.true();
      should(worker().requests).have.length(1);
    });
  });

  it('returns named worker failures without exposing a password', async () => {
    await withWorker({ kind: 'message', data: { ok: false, failure: 'wrong_password' } }, async (worker, spawn) => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn }).then(
        () => {
          throw new Error('wrong password must refuse');
        },
        error => {
          should(error).be.instanceof(PdfDecryptError);
          should((error as PdfDecryptError).failure).equal('wrong_password');
          should((error as Error).message.includes('use once')).be.false();
        },
      );
      should(worker().terminated).be.true();
    });
  });

  for (const failure of ['unreadable_document', 'too_large'] as const) {
    it(`surfaces the worker's ${failure} failure as that named failure`, async () => {
      await withWorker({ kind: 'message', data: { ok: false, failure } }, async (worker, spawn) => {
        await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn }).then(
          () => {
            throw new Error(`${failure} must refuse`);
          },
          error => {
            should(error).be.instanceof(PdfDecryptError);
            should((error as PdfDecryptError).failure).equal(failure);
          },
        );
        should(worker().terminated).be.true();
      });
    });
  }

  it('fails closed for malformed worker replies and worker errors', async () => {
    await withWorker({ kind: 'message', data: { ok: true, output: 'not bytes' } }, async (_worker, spawn) => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn }).then(
        () => {
          throw new Error('malformed reply must refuse');
        },
        error => should(error).have.property('failure', 'unreadable_document'),
      );
    });
    await withWorker({ kind: 'error' }, async (worker, spawn) => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn }).then(
        () => {
          throw new Error('worker error must refuse');
        },
        error => should(error).have.property('failure', 'unreadable_document'),
      );
      should(worker().terminated).be.true();
    });
  });

  it('terminates a worker that does not answer before the deadline', async () => {
    await withWorker({ kind: 'silent' }, async (worker, spawn) => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { timeoutMs: 1, spawn }).then(
        () => {
          throw new Error('timeout must refuse');
        },
        error => should(error).have.property('failure', 'decryption_timeout'),
      );
      should(worker().terminated).be.true();
    });
  });
});

describe('probePdfDecryptWorker', () => {
  it('should call the worker ready only when it answers the probe', async () => {
    await withWorker({ kind: 'message', data: { ok: true, probe: true } }, async (worker, spawn) => {
      should(await probePdfDecryptWorker({ spawn })).deepEqual({ ready: true });
      should(worker().requests).deepEqual([{ probe: true }]);
      should(worker().terminated).be.true();
    });
  });

  it('should say the worker started but qpdf did not load for any other answer', async () => {
    await withWorker(
      { kind: 'message', data: { ok: false, failure: 'unreadable_document' } },
      async (_worker, spawn) => {
        should(await probePdfDecryptWorker({ spawn })).deepEqual({
          ready: false,
          reason: 'the worker started but qpdf did not load',
        });
      },
    );
  });

  it('should report a worker that failed, never answered, or could not be created', async () => {
    await withWorker({ kind: 'error' }, async (_worker, spawn) => {
      should(await probePdfDecryptWorker({ spawn })).deepEqual({
        ready: false,
        reason: 'the worker failed: no detail',
      });
    });
    await withWorker({ kind: 'silent' }, async (worker, spawn) => {
      should(await probePdfDecryptWorker({ timeoutMs: 1, spawn })).deepEqual({
        ready: false,
        reason: 'no answer within 1 ms — the worker did not start',
      });
      should(worker().terminated).be.true();
    });
    await withWorker({ kind: 'unconstructable' }, async (_worker, spawn) => {
      should(await probePdfDecryptWorker({ spawn })).deepEqual({
        ready: false,
        reason: 'the worker could not be created: no such worker program',
      });
    });
  });

  it('should refuse a probe answer handed back to a decryption', async () => {
    await withWorker({ kind: 'message', data: { ok: true, probe: true } }, async (_worker, spawn) => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { spawn }).then(
        () => {
          throw new Error('a probe answer is not plaintext');
        },
        error => should(error).have.property('failure', 'unreadable_document'),
      );
    });
  });
});
