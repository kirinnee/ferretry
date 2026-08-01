import { describe, it } from 'bun:test';
import should from 'should';
import { insertTranscript, readSelection } from '../../../src/lib/stt/draft.ts';

describe('insertTranscript', () => {
  it('appends into an empty draft without inventing whitespace', () => {
    should(insertTranscript('', 0, 0, 'hello there')).deepEqual({ text: 'hello there', caret: 11 });
  });

  it('separates two words that would otherwise collide', () => {
    should(insertTranscript('hello', 5, 5, 'there')).deepEqual({ text: 'hello there', caret: 11 });
  });

  it('does not add a second space where the reader already typed one', () => {
    should(insertTranscript('hello ', 6, 6, 'there')).deepEqual({ text: 'hello there', caret: 11 });
  });

  it('does not space after an opening bracket', () => {
    should(insertTranscript('(', 1, 1, 'aside')).deepEqual({ text: '(aside', caret: 6 });
  });

  it('does not space before punctuation the utterance starts with', () => {
    should(insertTranscript('hello', 5, 5, ', friend')).deepEqual({ text: 'hello, friend', caret: 13 });
  });

  it('spaces before following text but leaves the caret in front of that space', () => {
    const result = insertTranscript('ab', 1, 1, 'mid');
    should(result.text).equal('a mid b');
    should(result.caret).equal(5);
    should(result.text.slice(result.caret)).equal(' b');
  });

  it('does not space before punctuation that follows the caret', () => {
    should(insertTranscript('!', 0, 0, 'wow')).deepEqual({ text: 'wow!', caret: 3 });
  });

  it('replaces a selection, because the reader meant to say that word again', () => {
    should(insertTranscript('the quick fox', 4, 9, 'slow')).deepEqual({ text: 'the slow fox', caret: 8 });
  });

  it('normalises a reversed selection rather than losing the utterance', () => {
    should(insertTranscript('the quick fox', 9, 4, 'slow')).deepEqual({ text: 'the slow fox', caret: 8 });
  });

  it('clamps a stale caret from a re-render to the end of the draft', () => {
    should(insertTranscript('abc', 99, 99, 'x')).deepEqual({ text: 'abc x', caret: 5 });
    should(insertTranscript('abc', -5, -5, 'x')).deepEqual({ text: 'x abc', caret: 1 });
  });

  it('treats a non-finite caret as the end of the draft', () => {
    should(insertTranscript('abc', Number.NaN, Number.NaN, 'x')).deepEqual({ text: 'abc x', caret: 5 });
  });

  it('trims the model output, which never has meaningful surrounding whitespace', () => {
    should(insertTranscript('', 0, 0, '  spoken  ')).deepEqual({ text: 'spoken', caret: 6 });
  });

  it('leaves the draft untouched when the utterance is empty', () => {
    should(insertTranscript('kept', 2, 2, '   ')).deepEqual({ text: 'kept', caret: 2 });
  });

  it('clamps the caret it reports back even for an empty utterance', () => {
    should(insertTranscript('kept', 0, 400, '')).deepEqual({ text: 'kept', caret: 4 });
  });
});

describe('readSelection', () => {
  it('reads a live selection off the element', () => {
    should(readSelection({ selectionStart: 2, selectionEnd: 5 }, 'abcdefg')).deepEqual([2, 5]);
  });

  it('appends at the end when the element is gone', () => {
    should(readSelection(null, 'abcd')).deepEqual([4, 4]);
    should(readSelection(undefined, 'abcd')).deepEqual([4, 4]);
  });

  it('appends at the end when the element reports nothing usable', () => {
    should(readSelection({ selectionStart: null, selectionEnd: null }, 'abcd')).deepEqual([4, 4]);
    should(readSelection({ selectionStart: 1, selectionEnd: null }, 'abcd')).deepEqual([4, 4]);
  });
});
