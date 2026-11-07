import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_PIN_PREVIEW_LENGTH, type Pin } from '@ferretry/protocol';
import {
  capPins,
  deduplicatePins,
  isPinBlockKind,
  isSafePinSessionId,
  normalizedPins,
  pinNoteText,
  pinPreview,
  pinProvenance,
  PinError,
} from '../../../src/lib/pins/index.ts';

const note = (id: string, by: 'human' | 'agent' = 'human'): Pin =>
  by === 'human'
    ? { id, at: 1, kind: 'note', text: id, by: 'human', createdBy: null, createdByName: null }
    : { id, at: 1, kind: 'note', text: id, by: 'agent', createdBy: 'agent-1', createdByName: null };

describe('pin policy', () => {
  it.each([
    { value: 'ms8deb5y-2083bbd5', expected: true },
    { value: 'a_b', expected: true },
    { value: '..', expected: false },
    { value: '../escape', expected: false },
    { value: 'UPPER', expected: false },
  ])('should accept only path-safe session IDs', ({ value, expected }) => {
    // Act
    const actual = isSafePinSessionId(value);

    // Assert
    should(actual).equal(expected);
  });

  it('should derive human and agent attribution from trusted actor context', () => {
    // Act
    const human = pinProvenance({ sessionId: ' user ', name: 'ignored' });
    const agent = pinProvenance({ sessionId: 'agent-1', name: '  Ada  ' });
    const unnamed = pinProvenance({ sessionId: 'agent-1', name: '  ' });

    // Assert
    should(human).deepEqual({ by: 'human', createdBy: null, createdByName: null, sessionId: null });
    should(agent).deepEqual({ by: 'agent', createdBy: 'agent-1', createdByName: 'Ada', sessionId: 'agent-1' });
    should(unnamed.createdByName).be.null();
  });

  it('should flatten previews without exceeding their wire cap', () => {
    // Act
    const short = pinPreview('  one\n two\tthree  ');
    const long = pinPreview('x'.repeat(MAX_PIN_PREVIEW_LENGTH + 1));

    // Assert
    should(short).equal('one two three');
    should(long).have.length(MAX_PIN_PREVIEW_LENGTH);
    should(long).endWith('…');
  });

  it('should identify only supported message block kinds', () => {
    // Act + Assert
    should(isPinBlockKind('assistant')).be.true();
    should(isPinBlockKind('document')).be.false();
    should(isPinBlockKind(undefined)).be.false();
  });

  it('should preserve note text but refuse blank, non-string, and oversized notes', () => {
    // Act + Assert
    should(pinNoteText('  keep whitespace  ')).equal('  keep whitespace  ');
    for (const value of ['', '   ', 2, 'x'.repeat(501)]) should(() => pinNoteText(value)).throw(PinError);
  });

  it('should retain the first identity and message target, then protect human capacity', () => {
    // Arrange
    const repeated = [
      note('first'),
      note('first'),
      { ...note('message'), kind: 'message' as const, blockId: 'block', blockKind: 'assistant' as const, preview: '' },
      { ...note('other'), kind: 'message' as const, blockId: 'block', blockKind: 'assistant' as const, preview: '' },
    ];
    const crowded = [...Array.from({ length: 11 }, (_, index) => note(`agent-${index}`, 'agent')), note('human')];

    // Act
    const unique = deduplicatePins(repeated);
    const capped = capPins(crowded);
    const normalized = normalizedPins([...repeated, ...crowded]);

    // Assert
    should(unique.map(pin => pin.id)).deepEqual(['first', 'message']);
    should(capped.map(pin => pin.id)).deepEqual([
      ...Array.from({ length: 10 }, (_, index) => `agent-${index}`),
      'human',
    ]);
    should(normalized.length).equal(13);
  });
});
