export interface PdfDecryptWorkerRequest {
  readonly input: ArrayBuffer;
  readonly password: string;
  readonly maxBytes: number;
}

export type PdfDecryptWorkerResponse =
  | { readonly ok: true; readonly output: ArrayBuffer }
  | { readonly ok: false; readonly failure: 'wrong_password' | 'unreadable_document' | 'too_large' };
