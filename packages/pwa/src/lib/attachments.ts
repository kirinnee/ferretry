/**
 * Browser-side attachment contracts and validation.
 *
 * The paired daemon remains authoritative: it validates content bytes and
 * confines attachment reads to its session store. These checks only prevent
 * obvious bad uploads and ensure the public PWA never renders daemon paths or
 * opaque daemon error text.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const ATTACHMENT_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

export type AttachmentErrorCode =
  | 'invalid_identifier'
  | 'invalid_filename'
  | 'empty_attachment'
  | 'attachment_too_large'
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'attachment_not_found'
  | 'corrupt_attachment'
  | 'wrong_password'
  | 'attachment_not_locked'
  | 'decryption_unavailable'
  | 'decryption_timeout'
  | 'decryption_failed';

/** Another password can help only for this daemon verdict. */
export const RETRYABLE_UNLOCK_ERROR_CODES: readonly AttachmentErrorCode[] = ['wrong_password'];

export const isRetryableUnlockError = (code: string | undefined): boolean =>
  code !== undefined && (RETRYABLE_UNLOCK_ERROR_CODES as readonly string[]).includes(code);

export interface UnlockFailure {
  readonly message: string;
  readonly retryable: boolean;
}

export interface TextExtraction {
  readonly method: 'pdfjs' | 'docx-xml';
  readonly characters: number;
  readonly truncated: boolean;
  readonly totalPages?: number;
  readonly pagesRead?: number;
}

export const TEXT_EXTRACTION_FAILURE_CODES = [
  'password_protected_document',
  'no_extractable_text',
  'unreadable_document',
  'document_extraction_timeout',
  'document_too_complex',
] as const;
export type KnownTextExtractionFailureCode = (typeof TEXT_EXTRACTION_FAILURE_CODES)[number];
export type TextExtractionFailureCode = KnownTextExtractionFailureCode | (string & {});

export interface TextExtractionFailure {
  readonly code: TextExtractionFailureCode;
  /** Metadata only: UI copy is selected from `code`, never this field. */
  readonly message: string;
}

export interface AttachmentEncryption {
  readonly kind: 'pdf';
  readonly locked: boolean;
  readonly expiresAt?: string;
  readonly decryptedSize?: number;
}

export interface AttachmentView {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly textExtraction?: TextExtraction;
  readonly textExtractionFailure?: TextExtractionFailure;
  readonly encrypted?: AttachmentEncryption;
}

export interface StoredTranscriptAttachment {
  readonly kind: 'attachment';
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly mime?: string;
  readonly size?: number;
  /** A tool path may be useful alt text but is never a request target. */
  readonly alt?: string;
  readonly textExtraction?: TextExtraction;
  readonly textExtractionFailure?: TextExtractionFailure;
  readonly encrypted?: AttachmentEncryption;
}

/** Compatibility name while transcript callers migrate from image-only UI. */
export type StoredTranscriptImage = StoredTranscriptAttachment;

export interface InlineTranscriptImage {
  readonly kind: 'inline';
  readonly src: string;
  readonly alt: string;
}

export type TranscriptImage = StoredTranscriptAttachment | InlineTranscriptImage;

const MIME_ALIASES: Readonly<Record<string, AttachmentMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-pdf': 'application/pdf',
  'text/x-markdown': 'text/markdown',
  'text/x-csv': 'text/csv',
};

const GENERIC_DECLARED_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const ERROR_COPY: Readonly<Record<AttachmentErrorCode, string>> = {
  attachment_too_large: 'Files must be 20 MiB or smaller',
  unsupported_mime: "That file type isn't supported",
  mime_mismatch: 'The file type does not match its contents',
  empty_attachment: 'That file is empty',
  invalid_filename: "That file can't be attached",
  invalid_identifier: "That file can't be attached",
  attachment_not_found: 'Attachment is no longer available — re-add it',
  corrupt_attachment: 'Attachment is no longer available — re-add it',
  wrong_password: 'That password did not open this PDF — try again',
  attachment_not_locked: 'That file is not encrypted; no password is needed',
  decryption_unavailable:
    'This daemon cannot hold a decrypted copy in memory, and will not write one to disk. Decrypt the PDF yourself and re-attach it.',
  decryption_timeout: 'Decrypting that PDF took too long — try again',
  decryption_failed: 'That PDF could not be decrypted; it may be corrupt or use an unsupported scheme',
};

const TEXT_EXTRACTION_FAILURE_COPY: Readonly<Record<KnownTextExtractionFailureCode, string>> = {
  password_protected_document:
    'Agent text extraction failed: this PDF or Word document needs a password, so it could not be read. The original remains attached and downloadable.',
  no_extractable_text: 'Agent text extraction failed: no readable text was found; it may be a scan.',
  unreadable_document: 'Agent text extraction failed: the document is unreadable or corrupt.',
  document_extraction_timeout: 'Agent text extraction failed: document reading timed out.',
  document_too_complex: 'Agent text extraction failed: the document is too complex or exceeds extraction limits.',
};

const UNKNOWN_TEXT_EXTRACTION_FAILURE_COPY =
  'Agent text extraction failed: the daemon could not read the document text. The original remains attached and downloadable.';
const MAX_TEXT_EXTRACTION_FAILURE_CODE_LENGTH = 64;
const TEXT_EXTRACTION_FAILURE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const attachmentErrorCopy = (code: AttachmentErrorCode): string => ERROR_COPY[code];

export const isTextExtraction = (value: unknown): value is TextExtraction => {
  if (value === null || typeof value !== 'object') return false;
  const extraction = value as Record<string, unknown>;
  return (
    (extraction.method === 'pdfjs' || extraction.method === 'docx-xml') &&
    typeof extraction.characters === 'number' &&
    typeof extraction.truncated === 'boolean' &&
    (extraction.totalPages === undefined || typeof extraction.totalPages === 'number') &&
    (extraction.pagesRead === undefined || typeof extraction.pagesRead === 'number')
  );
};

export const isTextExtractionFailure = (value: unknown): value is TextExtractionFailure => {
  if (value === null || typeof value !== 'object') return false;
  const failure = value as Record<string, unknown>;
  return (
    typeof failure.code === 'string' &&
    failure.code.length <= MAX_TEXT_EXTRACTION_FAILURE_CODE_LENGTH &&
    TEXT_EXTRACTION_FAILURE_CODE.test(failure.code) &&
    typeof failure.message === 'string' &&
    failure.message.length > 0 &&
    failure.message.length <= 500 &&
    failure.message === failure.message.trim() &&
    ![...failure.message].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  );
};

export const isAttachmentEncryption = (value: unknown): value is AttachmentEncryption => {
  if (value === null || typeof value !== 'object') return false;
  const encryption = value as Record<string, unknown>;
  return (
    encryption.kind === 'pdf' &&
    typeof encryption.locked === 'boolean' &&
    (encryption.expiresAt === undefined ||
      (typeof encryption.expiresAt === 'string' && !Number.isNaN(Date.parse(encryption.expiresAt)))) &&
    (encryption.decryptedSize === undefined ||
      (typeof encryption.decryptedSize === 'number' && Number.isFinite(encryption.decryptedSize)))
  );
};

export const attachmentLockCopy = (encryption: AttachmentEncryption): string =>
  encryption.locked
    ? 'Encrypted PDF — enter its password and the daemon will decrypt it in memory for the agent. The decrypted copy is never written to disk.'
    : 'Unlocked — the agent gets a decrypted copy that exists only in daemon memory. Nothing was written to disk and the stored original stays encrypted.';

export const textExtractionFailureCopy = (code: TextExtractionFailureCode): string =>
  (TEXT_EXTRACTION_FAILURE_CODES as readonly string[]).includes(code)
    ? TEXT_EXTRACTION_FAILURE_COPY[code as KnownTextExtractionFailureCode]
    : UNKNOWN_TEXT_EXTRACTION_FAILURE_COPY;

/** File.type is a declaration, not proof. Empty permits daemon byte sniffing. */
export const validateAttachmentFile = (file: Pick<File, 'size' | 'type'>): AttachmentErrorCode | null => {
  if (file.size === 0) return 'empty_attachment';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'attachment_too_large';
  const normalized = normalizeAttachmentMime(file.type.trim().toLowerCase());
  if (GENERIC_DECLARED_MIME_TYPES.has(normalized)) return null;
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalized) ? null : 'unsupported_mime';
};

export const normalizeAttachmentMime = (mime: string | undefined): string => {
  const bare = (mime ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIASES[bare] ?? bare;
};

export const isImageMime = (mime: string | undefined): boolean =>
  (IMAGE_MIME_TYPES as readonly string[]).includes(normalizeAttachmentMime(mime));

export const attachmentTypeLabel = (mime: string | undefined): string => {
  switch (normalizeAttachmentMime(mime)) {
    case 'application/pdf':
      return 'PDF document';
    case 'text/plain':
      return 'Text file';
    case 'text/markdown':
      return 'Markdown file';
    case 'text/csv':
      return 'CSV file';
    case 'application/json':
      return 'JSON file';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'Word document';
    default:
      return mime || 'File';
  }
};

export const isBrowserOpenableAttachment = (mime: string | undefined): boolean =>
  ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(
    normalizeAttachmentMime(mime),
  );

/** Maps opaque daemon failures to curated copy and refuses to echo local paths. */
export const attachmentErrorMessage = (error: unknown): string => {
  const object =
    error !== null && typeof error === 'object'
      ? (error as { readonly code?: unknown; readonly status?: unknown; readonly message?: unknown })
      : undefined;
  if (typeof object?.code === 'string' && object.code in ERROR_COPY)
    return ERROR_COPY[object.code as AttachmentErrorCode];
  if (object?.status === 404) return ERROR_COPY.attachment_not_found;

  const rawMessage = String(object?.message ?? error ?? '');
  const message = rawMessage.toLowerCase();
  if (/larger than|too large|byte limit/.test(message)) return ERROR_COPY.attachment_too_large;
  if (/declared mime.*does not match|mime mismatch/.test(message)) return ERROR_COPY.mime_mismatch;
  if (/unsupported (declared )?(mime|image type)/.test(message)) return ERROR_COPY.unsupported_mime;
  if (/attachment is empty|empty attachment/.test(message)) return ERROR_COPY.empty_attachment;
  if (/filename.*not safe|invalid filename/.test(message)) return ERROR_COPY.invalid_filename;
  if (/invalid (attachment|session) id/.test(message)) return ERROR_COPY.invalid_identifier;
  if (/not found|no longer available/.test(message)) return ERROR_COPY.attachment_not_found;
  if (/corrupt|manifest|escapes .*storage|content size/.test(message)) return ERROR_COPY.corrupt_attachment;
  if (/(?:^|[\\/])(?:home|tmp|var|private|attachments?)(?:[\\/]|$)/.test(message)) return ERROR_COPY.corrupt_attachment;
  if (typeof object?.status === 'number' && object.status >= 400 && object.status < 500 && rawMessage)
    return rawMessage;
  return 'File could not be attached — try again';
};

export const unlockFailure = (error: unknown): UnlockFailure => {
  const code =
    error !== null && typeof error === 'object' && typeof (error as { readonly code?: unknown }).code === 'string'
      ? (error as { readonly code: string }).code
      : undefined;
  return { message: attachmentErrorMessage(error), retryable: isRetryableUnlockError(code) };
};

export const attachmentFromView = (sessionId: string, view: AttachmentView): StoredTranscriptAttachment => {
  const textExtraction = isTextExtraction(view.textExtraction) ? view.textExtraction : undefined;
  const textExtractionFailure = isTextExtractionFailure(view.textExtractionFailure)
    ? view.textExtractionFailure
    : undefined;
  const encrypted = isAttachmentEncryption(view.encrypted) ? view.encrypted : undefined;
  return {
    kind: 'attachment',
    sessionId,
    attachmentId: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
    ...(textExtraction !== undefined && textExtractionFailure === undefined ? { textExtraction } : {}),
    ...(textExtractionFailure !== undefined && textExtraction === undefined ? { textExtractionFailure } : {}),
    ...(encrypted === undefined ? {} : { encrypted }),
  };
};

export const attachmentApiPath = (sessionId: string, attachmentId: string): string =>
  `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;

export const formatAttachmentSize = (bytes?: number): string => {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
