/**
 * Curated, reader-safe copy for encrypted attachment unlock attempts.
 *
 * Daemon failures can contain local paths or implementation detail. The PWA
 * renders only these messages, so an attachment's password flow cannot reveal
 * a paired daemon's filesystem layout.
 */
export interface AttachmentUnlockFailure {
  readonly message: string;
  /** Only a wrong password can be resolved by asking the reader again. */
  readonly retryable: boolean;
}

const FAILURE_COPY: Readonly<Record<string, string>> = {
  wrong_password: 'That password did not open this PDF — try again.',
  attachment_not_locked: 'This file is not encrypted, so no password is needed.',
  decryption_unavailable:
    'This daemon cannot keep a decrypted copy in memory and will not write one to disk. Decrypt the PDF yourself and attach that copy instead.',
  decryption_timeout: 'Decrypting that PDF took too long. Close this prompt and try again.',
  decryption_failed: 'That PDF could not be decrypted; it may be corrupt or use an unsupported scheme.',
  attachment_not_found: 'This attachment is no longer available. Add it again before retrying.',
};
const WRONG_PASSWORD_COPY = 'That password did not open this PDF — try again.';

/** Turns an opaque daemon error into the only unlock state the reader needs. */
export const attachmentUnlockFailure = (error: unknown): AttachmentUnlockFailure => {
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  if (code === 'wrong_password') return { message: WRONG_PASSWORD_COPY, retryable: true };
  return {
    message:
      (code === undefined ? undefined : FAILURE_COPY[code]) ??
      'This PDF could not be unlocked. Close this prompt and try again.',
    retryable: false,
  };
};
