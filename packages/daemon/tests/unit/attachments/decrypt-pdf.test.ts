import { describe, it } from 'bun:test';
import should from 'should';
import { decryptPdfInMemory, PdfDecryptError } from '../../../src/lib/attachments/index.ts';

type WorkerOutcome =
  | { readonly kind: 'message'; readonly data: unknown }
  | { readonly kind: 'error' }
  | { readonly kind: 'silent' };

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

async function withWorker<T>(outcome: WorkerOutcome, run: (worker: () => FakeWorker) => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers: FakeWorker[] = [];
  class ControlledWorker extends FakeWorker {
    constructor() {
      super(outcome);
      workers.push(this);
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ControlledWorker });
  try {
    return await run(() => {
      const worker = workers[0];
      if (worker === undefined) throw new Error('the decryptor did not construct a worker');
      return worker;
    });
  } finally {
    if (original === undefined) delete (globalThis as { Worker?: unknown }).Worker;
    else Object.defineProperty(globalThis, 'Worker', original);
  }
}

describe('decryptPdfInMemory', () => {
  it('returns worker output and terminates the disposable worker', async () => {
    const output = new Uint8Array([1, 2, 3]).buffer;
    await withWorker({ kind: 'message', data: { ok: true, output } }, async worker => {
      const actual = await decryptPdfInMemory(new Uint8Array([9]), 'use once');

      should([...actual]).deepEqual([1, 2, 3]);
      should(worker().terminated).be.true();
      should(worker().requests).have.length(1);
    });
  });

  it('returns named worker failures without exposing a password', async () => {
    await withWorker({ kind: 'message', data: { ok: false, failure: 'wrong_password' } }, async worker => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once').then(
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

  it('fails closed for malformed worker replies and worker errors', async () => {
    await withWorker({ kind: 'message', data: { ok: true, output: 'not bytes' } }, async () => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once').then(
        () => {
          throw new Error('malformed reply must refuse');
        },
        error => should(error).have.property('failure', 'unreadable_document'),
      );
    });
    await withWorker({ kind: 'error' }, async worker => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once').then(
        () => {
          throw new Error('worker error must refuse');
        },
        error => should(error).have.property('failure', 'unreadable_document'),
      );
      should(worker().terminated).be.true();
    });
  });

  it('terminates a worker that does not answer before the deadline', async () => {
    await withWorker({ kind: 'silent' }, async worker => {
      await decryptPdfInMemory(new Uint8Array([9]), 'use once', { timeoutMs: 1 }).then(
        () => {
          throw new Error('timeout must refuse');
        },
        error => should(error).have.property('failure', 'decryption_timeout'),
      );
      should(worker().terminated).be.true();
    });
  });
});
