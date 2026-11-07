import { describe, it } from 'bun:test';
import should from 'should';
import { PIN_SHORT_ID_LENGTH, assertEditablePin, resolvePinId, shortPinId } from '../../../src/lib/pins/pin-id';
import { MESSAGE_ID, NOTE_ID, humanMessage, humanNote } from './fixtures';

const pins = [humanNote(NOTE_ID, 'first'), humanMessage(MESSAGE_ID, 'second')];

describe('pin id resolution', () => {
  it('should shorten an id to the width the listing prints', () => {
    // Act
    const actual = shortPinId(NOTE_ID);

    // Assert
    should(actual).equal('11111111');
    should(actual).have.length(PIN_SHORT_ID_LENGTH);
  });

  it('should resolve a full uuid to itself', () => {
    // Act
    const actual = resolvePinId(pins, NOTE_ID);

    // Assert
    should(actual).equal(NOTE_ID);
  });

  it('should resolve the short id the listing printed', () => {
    // Act
    const actual = resolvePinId(pins, shortPinId(MESSAGE_ID));

    // Assert
    should(actual).equal(MESSAGE_ID);
  });

  it('should ignore surrounding whitespace and case', () => {
    // Arrange
    const mixedCase = [humanNote('AABBCCDD-1111-4111-8111-111111111111', 'shouty')];

    // Act
    const actual = resolvePinId(mixedCase, '  aabbccdd  ');

    // Assert
    should(actual).equal('AABBCCDD-1111-4111-8111-111111111111');
  });

  it('should reject an empty id', () => {
    // Act + Assert
    should(() => resolvePinId(pins, '   ')).throw(/a pin id is required/u);
  });

  it('should reject a prefix too short to identify anything', () => {
    // Act + Assert
    should(() => resolvePinId(pins, '11')).throw(/at least 4 characters/u);
  });

  it('should report an unknown prefix rather than sending it to the daemon', () => {
    // Act + Assert
    should(() => resolvePinId(pins, 'deadbeef')).throw(/no pin matches "deadbeef"/u);
  });

  it('should report every candidate when a prefix is ambiguous', () => {
    // Arrange
    const twins = [
      humanNote('abcd1111-1111-4111-8111-111111111111', 'one'),
      humanNote('abcd2222-2222-4222-8222-222222222222', 'two'),
    ];

    // Act + Assert
    should(() => resolvePinId(twins, 'abcd')).throw(/matches 2 pins \(abcd1111, abcd2222\)/u);
  });
});

describe('pin editability', () => {
  it('should accept a note pin', () => {
    // Act + Assert
    should(() => assertEditablePin(pins, NOTE_ID)).not.throw();
  });

  it('should refuse to edit a message pin', () => {
    // Act + Assert
    should(() => assertEditablePin(pins, MESSAGE_ID)).throw(/is a message pin — only note pins/u);
  });

  it('should stay silent about a pin the board does not hold', () => {
    // Act + Assert — the daemon owns "not found"; this guard only classifies pins it can see.
    should(() => assertEditablePin(pins, 'absent')).not.throw();
  });
});
