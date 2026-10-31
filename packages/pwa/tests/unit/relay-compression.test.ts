import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { acceptEncodingHeader } from '../../src/lib/relay-compression.ts';

const original = globalThis.DecompressionStream;

afterEach(() => {
  globalThis.DecompressionStream = original;
});

describe('asking a daemon for a compressed answer', () => {
  it('should ask for gzip where this browser can decode it', () => {
    // Assert
    should(acceptEncodingHeader()).eql({ 'accept-encoding': 'gzip' });
  });

  it('should never ask where this browser has no way to decode, so a daemon answers it plain', () => {
    // Arrange
    // @ts-expect-error — an older browser has no DecompressionStream at all.
    globalThis.DecompressionStream = undefined;

    // Assert
    should(acceptEncodingHeader()).eql({});
  });
});
