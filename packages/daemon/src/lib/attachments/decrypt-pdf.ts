import type { PdfDecryptWorkerRequest, PdfDecryptWorkerResponse } from './decrypt-pdf-worker.ts';

export type PdfDecryptFailure = 'wrong_password' | 'unreadable_document' | 'decryption_timeout' | 'too_large';

export class PdfDecryptError extends Error {
  constructor(readonly failure: PdfDecryptFailure) {
    super(
      failure === 'wrong_password'
        ? 'that password did not unlock this PDF'
        : failure === 'decryption_timeout'
          ? 'PDF decryption exceeded the processing time limit'
          : failure === 'too_large'
            ? 'the decrypted PDF exceeds the in-memory size limit'
            : 'this PDF could not be decrypted',
    );
  }
}

function workerResponse(value: unknown): value is PdfDecryptWorkerResponse {
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
  const worker = new Worker(new URL('./decrypt-pdf-worker.ts', import.meta.url), { type: 'module' });
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
