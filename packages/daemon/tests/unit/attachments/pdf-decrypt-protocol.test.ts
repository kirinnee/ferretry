import { describe, it } from 'bun:test';
import should from 'should';
import { PdfDecryptError, type PdfDecryptFailure } from '../../../src/lib/attachments/index.ts';

describe('PdfDecryptError', () => {
  it('should say what each refusal means without echoing a password', () => {
    // Arrange
    const failures: readonly PdfDecryptFailure[] = [
      'wrong_password',
      'decryption_timeout',
      'too_large',
      'unreadable_document',
    ];

    // Act
    const actual = failures.map(failure => new PdfDecryptError(failure));

    // Assert
    should(actual.map(error => [error.failure, error.message])).deepEqual([
      ['wrong_password', 'that password did not unlock this PDF'],
      ['decryption_timeout', 'PDF decryption exceeded the processing time limit'],
      ['too_large', 'the decrypted PDF exceeds the in-memory size limit'],
      ['unreadable_document', 'this PDF could not be decrypted'],
    ]);
  });
});
