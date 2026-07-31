import { describe, it } from 'bun:test';
import should from 'should';
import { describeAnswer, parseAnswer } from '../../../src/lib/attention/answer';

describe('answer flags', () => {
  it('should read no answer when no answer flag was given', () => {
    // Act
    const actual = parseAnswer({});

    // Assert — an item with no ask is resolved without a response.
    should(actual).be.undefined();
  });

  it('should read an approval and a rejection', () => {
    // Act + Assert
    should(parseAnswer({ approve: true })).deepEqual({ kind: 'permission', decision: 'approve' });
    should(parseAnswer({ reject: true })).deepEqual({ kind: 'permission', decision: 'reject' });
  });

  it('should read a choice', () => {
    // Act
    const actual = parseAnswer({ choice: '  ship it  ' });

    // Assert
    should(actual).deepEqual({ kind: 'multiple-choice', choice: 'ship it' });
  });

  it('should read an accepted review', () => {
    // Act
    const actual = parseAnswer({ good: true });

    // Assert
    should(actual).deepEqual({ kind: 'answer-review', verdict: 'good' });
  });

  it('should read a clarification request', () => {
    // Act
    const actual = parseAnswer({ clarify: 'which environment?' });

    // Assert
    should(actual).deepEqual({
      kind: 'answer-review',
      verdict: 'clarify',
      clarification: 'which environment?',
    });
  });

  it('should read an open answer', () => {
    // Act
    const actual = parseAnswer({ answer: 'use the staging cluster' });

    // Assert
    should(actual).deepEqual({ kind: 'open-question', answer: 'use the staging cluster' });
  });
});

describe('conflicting answers', () => {
  it('should refuse an approval and a rejection together', () => {
    // Act + Assert
    should(() => parseAnswer({ approve: true, reject: true })).throw(/exactly one answer/u);
  });

  it('should refuse a review verdict and a clarification together', () => {
    // Act + Assert
    should(() => parseAnswer({ good: true, clarify: 'but' })).throw(/exactly one answer/u);
  });

  it('should refuse answers of two different kinds', () => {
    // Act + Assert
    should(() => parseAnswer({ approve: true, answer: 'yes' })).throw(/exactly one answer/u);
    should(() => parseAnswer({ choice: 'a', good: true })).throw(/exactly one answer/u);
  });

  it('should refuse a blank choice', () => {
    // Act + Assert
    should(() => parseAnswer({ choice: '   ' })).throw(/--choice needs the label of one listed option/u);
  });

  it('should refuse a blank clarification', () => {
    // Act + Assert
    should(() => parseAnswer({ clarify: '' })).throw(/--clarify needs the clarification text/u);
  });

  it('should refuse a blank answer', () => {
    // Act + Assert
    should(() => parseAnswer({ answer: '  ' })).throw(/--answer needs the answer text/u);
  });
});

describe('describing a recorded answer', () => {
  it('should describe every response kind', () => {
    // Act + Assert
    should(describeAnswer({ kind: 'permission', decision: 'approve' })).equal('approved');
    should(describeAnswer({ kind: 'permission', decision: 'reject' })).equal('rejected');
    should(describeAnswer({ kind: 'multiple-choice', choice: 'hold' })).equal('chose "hold"');
    should(describeAnswer({ kind: 'answer-review', verdict: 'good' })).equal('answer accepted');
    should(describeAnswer({ kind: 'answer-review', verdict: 'clarify', clarification: 'which?' })).equal(
      'clarification requested: which?',
    );
    should(describeAnswer({ kind: 'open-question', answer: 'staging' })).equal('answered: staging');
  });
});
