import { describe, expect, test } from 'bun:test';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentApiPath,
  attachmentErrorCopy,
  attachmentErrorMessage,
  attachmentFromView,
  attachmentLockCopy,
  attachmentTypeLabel,
  formatAttachmentSize,
  isAttachmentEncryption,
  isBrowserOpenableAttachment,
  isImageMime,
  isRetryableUnlockError,
  isTextExtraction,
  isTextExtractionFailure,
  normalizeAttachmentMime,
  textExtractionFailureCopy,
  unlockFailure,
  validateAttachmentFile,
} from '../../src/lib/attachments.ts';

describe('attachments', () => {
  test('normalizes, classifies, labels, and validates only the supported browser file declarations', () => {
    expect(normalizeAttachmentMime(' IMAGE/PJPEG ; charset=binary')).toBe('image/jpeg');
    expect(normalizeAttachmentMime(undefined)).toBe('');
    expect(isImageMime('image/jpg')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
    expect(attachmentTypeLabel('application/x-pdf')).toBe('PDF document');
    expect(attachmentTypeLabel('text/plain')).toBe('Text file');
    expect(attachmentTypeLabel('text/x-markdown')).toBe('Markdown file');
    expect(attachmentTypeLabel('text/x-csv')).toBe('CSV file');
    expect(attachmentTypeLabel('application/json')).toBe('JSON file');
    expect(attachmentTypeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'Word document',
    );
    expect(attachmentTypeLabel('video/mp4')).toBe('video/mp4');
    expect(attachmentTypeLabel(undefined)).toBe('File');
    expect(isBrowserOpenableAttachment('text/x-markdown')).toBe(true);
    expect(isBrowserOpenableAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      false,
    );
    expect(validateAttachmentFile({ size: 0, type: 'image/png' })).toBe('empty_attachment');
    expect(validateAttachmentFile({ size: MAX_ATTACHMENT_BYTES + 1, type: 'image/png' })).toBe('attachment_too_large');
    expect(validateAttachmentFile({ size: 4, type: 'application/octet-stream' })).toBeNull();
    expect(validateAttachmentFile({ size: 4, type: ' image/jpg ' })).toBeNull();
    expect(validateAttachmentFile({ size: 4, type: 'application/zip' })).toBe('unsupported_mime');
  });

  test('accepts only well-formed extraction and encryption metadata', () => {
    expect(isTextExtraction({ method: 'pdfjs', characters: 42, truncated: false, totalPages: 2, pagesRead: 1 })).toBe(
      true,
    );
    expect(isTextExtraction({ method: 'other', characters: 42, truncated: false })).toBe(false);
    expect(isTextExtraction(null)).toBe(false);
    expect(isTextExtractionFailure({ code: 'document_too_complex', message: 'Timed out safely' })).toBe(true);
    expect(isTextExtractionFailure({ code: 'bad-code', message: 'Timed out safely' })).toBe(false);
    expect(isTextExtractionFailure({ code: 'valid_code', message: ' trailing ' })).toBe(false);
    expect(isTextExtractionFailure({ code: 'valid_code', message: 'bad\nmessage' })).toBe(false);
    expect(
      isAttachmentEncryption({ kind: 'pdf', locked: true, expiresAt: '2026-08-01T00:00:00Z', decryptedSize: 4 }),
    ).toBe(true);
    expect(isAttachmentEncryption({ kind: 'pdf', locked: false, expiresAt: 'bad-date' })).toBe(false);
    expect(isAttachmentEncryption({ kind: 'word', locked: true })).toBe(false);
    expect(attachmentLockCopy({ kind: 'pdf', locked: true })).toContain('never written to disk');
    expect(attachmentLockCopy({ kind: 'pdf', locked: false })).toContain('stored original stays encrypted');
    expect(textExtractionFailureCopy('no_extractable_text')).toContain('no readable text');
    expect(textExtractionFailureCopy('future_daemon_code')).toContain('original remains attached');
  });

  test('never leaks opaque storage errors and keeps the one retryable unlock verdict', () => {
    expect(attachmentErrorCopy('mime_mismatch')).toContain('does not match');
    expect(attachmentErrorMessage({ code: 'wrong_password' })).toContain('try again');
    expect(attachmentErrorMessage({ status: 404, message: '/home/daemon/private/file.pdf' })).toContain(
      'no longer available',
    );
    expect(attachmentErrorMessage(new Error('/home/daemon/private/file.pdf'))).toContain('no longer available');
    expect(attachmentErrorMessage('declared MIME does not match bytes')).toContain('does not match');
    expect(attachmentErrorMessage('unsupported image type')).toContain("isn't supported");
    expect(attachmentErrorMessage('attachment is empty')).toContain('empty');
    expect(attachmentErrorMessage('filename is not safe')).toContain("can't be attached");
    expect(attachmentErrorMessage('invalid session id')).toContain("can't be attached");
    expect(attachmentErrorMessage('corrupt manifest')).toContain('no longer available');
    expect(attachmentErrorMessage({ status: 422, message: 'A safe validation message' })).toBe(
      'A safe validation message',
    );
    expect(attachmentErrorMessage(undefined)).toBe('File could not be attached — try again');
    expect(isRetryableUnlockError('wrong_password')).toBe(true);
    expect(isRetryableUnlockError('decryption_failed')).toBe(false);
    expect(unlockFailure({ code: 'wrong_password' })).toMatchObject({ retryable: true });
    expect(unlockFailure({ code: 'decryption_failed' })).toMatchObject({ retryable: false });
  });

  test('derives safe transcript records, endpoint paths, and display sizes', () => {
    const attachment = attachmentFromView('session/a', {
      id: 'att_1',
      filename: 'statement.pdf',
      mime: 'application/pdf',
      size: 1_024,
      sha256: 'a'.repeat(64),
      createdAt: '2026-08-01T00:00:00Z',
      textExtraction: { method: 'pdfjs', characters: 10, truncated: false },
      encrypted: { kind: 'pdf', locked: true },
    });
    expect(attachment).toMatchObject({ sessionId: 'session/a', attachmentId: 'att_1', encrypted: { locked: true } });
    expect(attachmentApiPath('session/a', 'att 1')).toBe('/v1/sessions/session%2Fa/attachments/att%201');
    expect(formatAttachmentSize()).toBe('');
    expect(formatAttachmentSize(-1)).toBe('');
    expect(formatAttachmentSize(99)).toBe('99 B');
    expect(formatAttachmentSize(2_048)).toBe('2.0 KB');
    expect(formatAttachmentSize(20 * 1024)).toBe('20 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatAttachmentSize(20 * 1024 * 1024)).toBe('20 MB');
  });
});
