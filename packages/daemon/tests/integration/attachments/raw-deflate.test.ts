import { describe, it } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import should from 'should';
import { NodeRawDeflate } from '../../../src/adapters/index.ts';

describe('NodeRawDeflate', () => {
  it('should inflate a raw DEFLATE payload within its explicit size limit', () => {
    // Arrange
    const original = new TextEncoder().encode('bounded document text');
    const compressed = new Uint8Array(deflateRawSync(original));
    const subject = new NodeRawDeflate();

    // Act
    const actual = subject.inflateRaw(compressed, original.byteLength);

    // Assert
    should(new TextDecoder().decode(actual)).equal('bounded document text');
  });

  it('should refuse output that exceeds the configured limit', () => {
    // Arrange
    const compressed = new Uint8Array(deflateRawSync(new TextEncoder().encode('this expands beyond five bytes')));
    const subject = new NodeRawDeflate();

    // Act + Assert
    should(() => subject.inflateRaw(compressed, 5)).throw();
  });
});
