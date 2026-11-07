import type { Clock, WorkersPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  PdfDecryptError,
  type PdfDecryptProbeRequest,
  type PdfDecryptWorkerRequest,
  type PdfDecryptWorkerResponse,
} from '../lib/pdf-decrypt-protocol.ts';

/** The worker that runs qpdf; a module of this package, started through the kernel's workers port. */
const PDF_WORKER_URL = new URL('../worker/pdf-decrypt.worker.ts', import.meta.url);

/** A decryption's answer: never a probe's, which only {@link probePdfDecryptWorker} asks for. */
type DecryptAnswer = Exclude<PdfDecryptWorkerResponse, { readonly probe: true }>;

function workerResponse(value: unknown): value is DecryptAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as { ok?: unknown; output?: unknown; failure?: unknown };
  return (
    (response.ok === true && response.output instanceof ArrayBuffer) ||
    (response.ok === false &&
      (response.failure === 'wrong_password' ||
        response.failure === 'unreadable_document' ||
        response.failure === 'too_large'))
  );
}

export interface PdfWorkerPorts {
  readonly workers: Pick<WorkersPort, 'start'>;
  readonly clock: Pick<Clock, 'after'>;
}

/**
 * Runs one PDF unlock attempt in an isolated worker and returns only heap bytes.
 *
 * The worker is terminated after every attempt. It owns qpdf's virtual filesystem, password, parser state and
 * intermediate plaintext; none of those are backed by the host filesystem. The caller keeps the returned bytes only in
 * its own memory.
 */
export async function decryptPdfInMemory(
  ports: PdfWorkerPorts,
  encrypted: Uint8Array,
  password: string,
  { timeoutMs = 20_000, maxBytes = 40 * 1024 * 1024 }: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  const worker = ports.workers.start(PDF_WORKER_URL, { name: 'pdf-decrypt' });
  const input = encrypted.slice();
  let stop: () => void = () => undefined;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cancel();
        stop();
        action();
      };
      const cancel = ports.clock.after(milliseconds(timeoutMs), () =>
        finish(() => reject(new PdfDecryptError('decryption_timeout'))),
      );
      stop = worker.onMessage(response => {
        if (!workerResponse(response)) return finish(() => reject(new PdfDecryptError('unreadable_document')));
        if (response.ok) return finish(() => resolve(new Uint8Array(response.output)));
        return finish(() => reject(new PdfDecryptError(response.failure)));
      });
      const request: PdfDecryptWorkerRequest = { input: input.buffer as ArrayBuffer, password, maxBytes };
      worker.post(request, [input.buffer as ArrayBuffer]);
    });
  } finally {
    await worker.terminate();
  }
}

/** Whether the PDF worker starts and loads qpdf here, and if not, why: for `fy doctor`. */
export type PdfWorkerProbe = { readonly ready: true } | { readonly ready: false; readonly reason: string };

/**
 * Starts the PDF worker, asks it to load qpdf, and ends it. The one end-to-end proof that this process can unlock a PDF
 * at all: a compiled binary that did not embed the worker, or the wasm it loads, used to fail only when somebody typed
 * a password.
 */
export async function probePdfDecryptWorker(
  ports: PdfWorkerPorts,
  { timeoutMs = 20_000 }: { readonly timeoutMs?: number } = {},
): Promise<PdfWorkerProbe> {
  let worker: ReturnType<WorkersPort['start']>;
  try {
    worker = ports.workers.start(PDF_WORKER_URL, { name: 'pdf-decrypt-probe' });
  } catch (error) {
    return {
      ready: false,
      reason: `the worker could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return await new Promise<PdfWorkerProbe>(resolve => {
      const cancel = ports.clock.after(milliseconds(timeoutMs), () =>
        resolve({ ready: false, reason: `no answer within ${String(timeoutMs)} ms — the worker did not start` }),
      );
      worker.onMessage(message => {
        cancel();
        const answer = message as { ok?: unknown; probe?: unknown } | null;
        resolve(
          answer?.ok === true && answer.probe === true
            ? { ready: true }
            : { ready: false, reason: 'the worker started but qpdf did not load' },
        );
      });
      const request: PdfDecryptProbeRequest = { probe: true };
      worker.post(request);
    });
  } finally {
    await worker.terminate();
  }
}
