import { describe, expect, test } from 'bun:test';
import type { Cancel, WorkerHandle } from '@ferretry/kernel/contract';
import { decryptPdfInMemory, probePdfDecryptWorker } from '../../../daemon/attachments/adapters/decrypt-pdf.ts';
import { PdfDecryptError } from '../../../daemon/attachments/lib/index.ts';

type WorkerOutcome =
  | { readonly kind: 'message'; readonly data: unknown }
  | { readonly kind: 'silent' }
  | { readonly kind: 'unconstructable' };

class FakeWorker implements WorkerHandle {
  listener: ((message: unknown) => void) | undefined;
  terminated = false;
  requests: unknown[] = [];

  constructor(private readonly outcome: WorkerOutcome) {}

  post(message: unknown): void {
    this.requests.push(message);
    queueMicrotask(() => {
      if (this.outcome.kind === 'message') this.listener?.(this.outcome.data);
    });
  }

  onMessage(listener: (message: unknown) => void): Cancel {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

/** Ports whose workers answer `outcome`, and whose deadline fires at once when the worker stays silent. */
function ports(outcome: WorkerOutcome) {
  const workers: FakeWorker[] = [];
  return {
    workers,
    ports: {
      workers: {
        start: () => {
          if (outcome.kind === 'unconstructable') throw new Error('no such worker program');
          const worker = new FakeWorker(outcome);
          workers.push(worker);
          return worker;
        },
      },
      clock: {
        after: (_delay: number, fn: () => void): Cancel => {
          if (outcome.kind === 'silent') queueMicrotask(fn);
          return () => undefined;
        },
      },
    } as never,
  };
}

const refusal = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );

describe('decryptPdfInMemory', () => {
  test('returns worker output and terminates the disposable worker', async () => {
    const output = new Uint8Array([1, 2, 3]).buffer;
    const { ports: p, workers } = ports({ kind: 'message', data: { ok: true, output } });
    const actual = await decryptPdfInMemory(p, new Uint8Array([9]), 'use once');
    expect([...actual]).toEqual([1, 2, 3]);
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[0]?.requests).toHaveLength(1);
  });

  test('returns named worker failures without exposing a password', async () => {
    for (const failure of ['wrong_password', 'unreadable_document', 'too_large'] as const) {
      const { ports: p, workers } = ports({ kind: 'message', data: { ok: false, failure } });
      const error = await refusal(decryptPdfInMemory(p, new Uint8Array([9]), 'use once'));
      expect(error).toBeInstanceOf(PdfDecryptError);
      expect((error as PdfDecryptError).failure).toBe(failure);
      expect((error as Error).message.includes('use once')).toBe(false);
      expect(workers[0]?.terminated).toBe(true);
    }
  });

  test('fails closed for a malformed worker reply', async () => {
    const { ports: p } = ports({ kind: 'message', data: { ok: true, output: 'not bytes' } });
    expect(await refusal(decryptPdfInMemory(p, new Uint8Array([9]), 'use once'))).toHaveProperty(
      'failure',
      'unreadable_document',
    );
  });

  test('terminates a worker that does not answer before the deadline', async () => {
    const { ports: p, workers } = ports({ kind: 'silent' });
    expect(await refusal(decryptPdfInMemory(p, new Uint8Array([9]), 'use once', { timeoutMs: 1 }))).toHaveProperty(
      'failure',
      'decryption_timeout',
    );
    expect(workers[0]?.terminated).toBe(true);
  });

  test('refuses a probe answer handed back to a decryption', async () => {
    const { ports: p } = ports({ kind: 'message', data: { ok: true, probe: true } });
    expect(await refusal(decryptPdfInMemory(p, new Uint8Array([9]), 'use once'))).toHaveProperty(
      'failure',
      'unreadable_document',
    );
  });
});

describe('probePdfDecryptWorker', () => {
  test('calls the worker ready only when it answers the probe', async () => {
    const { ports: p, workers } = ports({ kind: 'message', data: { ok: true, probe: true } });
    expect(await probePdfDecryptWorker(p)).toEqual({ ready: true });
    expect(workers[0]?.requests).toEqual([{ probe: true }]);
    expect(workers[0]?.terminated).toBe(true);
  });

  test('says the worker started but qpdf did not load for any other answer', async () => {
    const { ports: p } = ports({ kind: 'message', data: { ok: false, failure: 'unreadable_document' } });
    expect(await probePdfDecryptWorker(p)).toEqual({
      ready: false,
      reason: 'the worker started but qpdf did not load',
    });
  });

  test('reports a worker that never answered or could not be created', async () => {
    const silent = ports({ kind: 'silent' });
    expect(await probePdfDecryptWorker(silent.ports, { timeoutMs: 1 })).toEqual({
      ready: false,
      reason: 'no answer within 1 ms — the worker did not start',
    });
    expect(silent.workers[0]?.terminated).toBe(true);
    expect(await probePdfDecryptWorker(ports({ kind: 'unconstructable' }).ports)).toEqual({
      ready: false,
      reason: 'the worker could not be created: no such worker program',
    });
  });
});
