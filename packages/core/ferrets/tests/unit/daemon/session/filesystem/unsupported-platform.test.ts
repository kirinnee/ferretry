import { describe, it } from 'bun:test';
import should from 'should';
import { unsupportedPlatform } from '../../../../src/lib/session/filesystem/index.ts';

/**
 * The words a viewer shows when the whole surface is closed.
 *
 * Asserted because they are a CONTRACT with a reader rather than an internal string: a person has to
 * learn from them that their computer, not their configuration, is why the feature is missing, and a
 * developer has to learn which mechanism is absent without opening the source. The `unsupported` code
 * is asserted alongside because it is what stops a client from offering a retry.
 */

describe('unsupportedPlatform', () => {
  it('should name a known system the way its owner does', () => {
    // Act
    const refusal = unsupportedPlatform('darwin');

    // Assert
    should(refusal.code).eql('unsupported');
    should(refusal.message).match(/^file browsing is not available on macOS yet/);
    should(refusal.message).match(/holding that folder open/);
  });

  it('should say Windows rather than win32', () => {
    // Act / Assert
    should(unsupportedPlatform('win32').message).match(/not available on Windows yet/);
  });

  it('should repeat an unknown system verbatim rather than invent a friendly name for it', () => {
    // Arrange: a system nobody here has run this on. Guessing a name would imply it was considered.
    // Act / Assert
    should(unsupportedPlatform('sunos').message).match(/not available on sunos yet/);
  });
});
