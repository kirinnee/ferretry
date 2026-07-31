import { describe, it } from 'bun:test';
import should from 'should';
import {
  normalizeTranscriptQuestions,
  transcriptJsonValue,
  transcriptText,
} from '../../../src/lib/transcript/value.ts';

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

  it('should count malformed question and option entries while preserving valid siblings', () => {
    // Act
    const absent = normalizeTranscriptQuestions({});
    const invalidContainer = normalizeTranscriptQuestions({ questions: 'not-an-array' });
    const mixed = normalizeTranscriptQuestions({
      questions: [
        { question: 'Valid?', options: [{ label: 'Yes', description: 'Continue.' }, null] },
        { question: 'Bad options?', options: {} },
        { header: 'Missing question' },
      ],
    });

    // Assert
    should(absent).deepEqual({ questions: [], invalidEntries: 0 });
    should(invalidContainer).deepEqual({ questions: [], invalidEntries: 1 });
    should(mixed.questions).containDeep([
      { question: 'Valid?', options: [{ label: 'Yes', description: 'Continue.' }] },
      { question: 'Bad options?', options: [] },
    ]);
    should(mixed.invalidEntries).equal(3);
  });
});
