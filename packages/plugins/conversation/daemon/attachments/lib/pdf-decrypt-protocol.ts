export interface PdfDecryptWorkerRequest {
  readonly input: ArrayBuffer;
  readonly password: string;
  readonly maxBytes: number;
}

/** Asks the worker only to prove it started and loaded qpdf; it answers `{ ok: true, probe: true }`. */
export interface PdfDecryptProbeRequest {
  readonly probe: true;
}

export type PdfDecryptWorkerResponse =
  | { readonly ok: true; readonly output: ArrayBuffer }
  | { readonly ok: true; readonly probe: true }
  | { readonly ok: false; readonly failure: 'wrong_password' | 'unreadable_document' | 'too_large' };

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

/**
 * One PDF unlock attempt: the encrypted original and a use-once password in, plaintext bytes out.
 * A refusal is a {@link PdfDecryptError}. The store receives this as a constructor dependency, so the
 * worker that actually runs qpdf stays an adapter concern.
 */
export type PdfDecryptor = (encrypted: Uint8Array, password: string) => Promise<Uint8Array>;
