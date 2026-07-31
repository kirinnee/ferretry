import { describe, it } from 'bun:test';
import { MAX_ATTENTION_ASK_OPTIONS } from '@ferretry/protocol';
import should from 'should';
import { ASK_KIND_NAMES, parseAsk } from '../../../src/lib/attention/ask';

describe('ask kinds', () => {
  it('should default to an open question', () => {
    // Act
    const actual = parseAsk({});

    // Assert
    should(actual).deepEqual({ kind: 'open-question' });
  });

  it('should map every short name to its protocol kind', () => {
    // Act + Assert
    should(parseAsk({ kind: 'permission' })).deepEqual({ kind: 'permission' });
    should(parseAsk({ kind: 'review' })).deepEqual({ kind: 'answer-review' });
    should(parseAsk({ kind: 'open' })).deepEqual({ kind: 'open-question' });
  });

  it('should also accept the protocol kind spelled in full', () => {
    // Act + Assert
    should(parseAsk({ kind: 'answer-review' })).deepEqual({ kind: 'answer-review' });
    should(parseAsk({ kind: '  open-question  ' })).deepEqual({ kind: 'open-question' });
  });

  it('should list the accepted names when the kind is unknown', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'maybe' })).throw(
      new RegExp(`unknown --kind "maybe" — use ${ASK_KIND_NAMES.join(', ')}`, 'u'),
    );
  });
});

describe('choice asks', () => {
  it('should build a choice from two options', () => {
    // Act
    const actual = parseAsk({ kind: 'choice', option: ['ship it', 'hold'] });

    // Assert
    should(actual).deepEqual({ kind: 'multiple-choice', options: [{ label: 'ship it' }, { label: 'hold' }] });
  });

  it('should infer a choice when options are given without a kind', () => {
    // Act
    const actual = parseAsk({ option: ['a', 'b'] });

    // Assert
    should(actual).have.property('kind', 'multiple-choice');
  });

  it('should accept the protocol spelling of the kind', () => {
    // Act
    const actual = parseAsk({ kind: 'multiple-choice', option: ['a', 'b'] });

    // Assert
    should(actual).have.property('kind', 'multiple-choice');
  });

  it('should drop blank options before counting them', () => {
    // Act + Assert — two labels and a stray empty --option is still a valid two-option choice.
    should(parseAsk({ kind: 'choice', option: ['a', '   ', 'b'] })).deepEqual({
      kind: 'multiple-choice',
      options: [{ label: 'a' }, { label: 'b' }],
    });
  });

  it('should refuse a choice with fewer than two options', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['only'] })).throw(/needs 2 to 12 distinct --option labels/u);
  });

  it('should refuse a choice with duplicate labels', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['same', 'same'] })).throw(/distinct --option labels/u);
  });

  it('should refuse more options than the protocol allows', () => {
    // Arrange
    const tooMany = Array.from({ length: MAX_ATTENTION_ASK_OPTIONS + 1 }, (_, index) => `option-${index}`);

    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: tooMany })).throw(/needs 2 to 12 distinct/u);
  });

  it('should refuse an option label spanning more than one line', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'choice', option: ['fine', 'two\nlines'] })).throw(/each one line/u);
  });

  it('should refuse options on a kind that has none', () => {
    // Act + Assert
    should(() => parseAsk({ kind: 'permission', option: ['a', 'b'] })).throw(
      /--option only makes sense with --kind choice, not permission/u,
    );
  });
});
