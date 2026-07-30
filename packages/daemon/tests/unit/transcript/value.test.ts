import { describe, it } from 'bun:test';
import should from 'should';
import { transcriptJsonValue, transcriptText } from '../../../src/lib/transcript/value.ts';

describe('transcript value normalization', () => {
  it('should extract text from objects and mixed arrays', () => {
    // Act
    const fromObject = transcriptText({ output_text: 'object text' });
    const fromArray = transcriptText(['plain text', { text: 'block text' }, { ignored: true }]);

    // Assert
    should(fromObject).equal('object text');
    should(fromArray).equal('plain text\nblock text');
  });

  it('should normalize non-JSON values and cycles without throwing', () => {
    // Arrange
    const cycle: Record<string, unknown> = { finite: 1, invalid: Number.NaN, omitted: undefined };
    cycle.self = cycle;

    // Act
    const actual = transcriptJsonValue({ cycle, bigint: 1n, callback: () => undefined });

    // Assert
    should(actual).deepEqual({ cycle: { finite: 1, invalid: null, self: null }, bigint: null, callback: null });
  });
});
