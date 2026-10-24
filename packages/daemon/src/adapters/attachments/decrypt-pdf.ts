import {
  PdfDecryptError,
  type PdfDecryptProbeRequest,
  type PdfDecryptWorkerRequest,
  type PdfDecryptWorkerResponse,
} from '../../lib/attachments/pdf-decrypt-protocol.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import { LoadSafeWorker } from '../runtime/load-safe-worker.ts';

/** A decryption's answer — never a probe's, which only `probePdfDecryptWorker` asks for. */
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

/**
 * Runs one PDF unlock attempt in an isolated worker and returns only heap bytes.
 *
 * The worker is terminated after every attempt. It owns qpdf's virtual filesystem,
 * password, parser state, and intermediate plaintext; none of those are backed by
 * the host filesystem. The caller keeps the returned bytes only in its own memory.
 */
export async function decryptPdfInMemory(
  encrypted: Uint8Array,
  password: string,
  { timeoutMs = 20_000, maxBytes = 40 * 1024 * 1024 }: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  const worker = new LoadSafeWorker(bundledWorkerUrl('pdf-decrypt'), { type: 'module' });
  const input = encrypted.slice();
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action();
      };
      const timeout = setTimeout(() => finish(() => reject(new PdfDecryptError('decryption_timeout'))), timeoutMs);
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const response = event.data;
        if (!workerResponse(response)) return finish(() => reject(new PdfDecryptError('unreadable_document')));
        if (response.ok) return finish(() => resolve(new Uint8Array(response.output)));
        return finish(() => reject(new PdfDecryptError(response.failure)));
      };
      worker.onerror = () => finish(() => reject(new PdfDecryptError('unreadable_document')));
      const request: PdfDecryptWorkerRequest = { input: input.buffer as ArrayBuffer, password, maxBytes };
      worker.postMessage(request, [input.buffer as ArrayBuffer]);
    });
  } finally {
    worker.terminate();
  }
}

/** Whether the PDF worker starts and loads qpdf here, and if not, why — for `fyd --check`. */
export type PdfWorkerProbe = { readonly ready: true } | { readonly ready: false; readonly reason: string };

/**
 * Starts the PDF worker, asks it to load qpdf, and ends it.
 *
 * The one end-to-end proof that this process can unlock a PDF at all: a compiled binary that did not
 * embed the worker, or the wasm it loads, used to fail only when somebody typed a password.
 */
export async function probePdfDecryptWorker({
  timeoutMs = 20_000,
}: { readonly timeoutMs?: number } = {}): Promise<PdfWorkerProbe> {
  let worker: Worker;
  try {
    worker = new LoadSafeWorker(bundledWorkerUrl('pdf-decrypt'), { type: 'module' });
  } catch (error) {
    return {
      ready: false,
      reason: `the worker could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return await new Promise<PdfWorkerProbe>(resolve => {
      const timeout = setTimeout(
        () => resolve({ ready: false, reason: `no answer within ${String(timeoutMs)} ms — the worker did not start` }),
        timeoutMs,
      );
      const settle = (probe: PdfWorkerProbe): void => {
        clearTimeout(timeout);
        resolve(probe);
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const answer = event.data as { ok?: unknown; probe?: unknown } | null;
        settle(
          answer?.ok === true && answer.probe === true
            ? { ready: true }
            : { ready: false, reason: 'the worker started but qpdf did not load' },
        );
      };
      worker.onerror = event => settle({ ready: false, reason: `the worker failed: ${event?.message ?? 'no detail'}` });
      const request: PdfDecryptProbeRequest = { probe: true };
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}
