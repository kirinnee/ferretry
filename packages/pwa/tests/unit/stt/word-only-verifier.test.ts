import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyWordChange,
  innerPunctuation,
  isWholeWord,
  MAX_VERIFY_CHARS,
  segmentWords,
  verifyWordOnly,
} from '../../../src/lib/stt/word-only-verifier.ts';

describe('segmentWords', () => {
  it('alternates separator/word and always brackets the text with a separator', () => {
    const segmentation = segmentWords('hi, there');
    should(segmentation.words).deepEqual(['hi', 'there']);
    should(segmentation.separators).deepEqual(['', ', ', '']);
    should(segmentation.separators.length).equal(segmentation.words.length + 1);
  });

  it('keeps inner punctuation inside the word rather than in the separator stream', () => {
    should(segmentWords("don't sherpa-onnx tool_use").words).deepEqual(["don't", 'sherpa-onnx', 'tool_use']);
  });

  it('handles a text with no words at all', () => {
    should(segmentWords('!!! ').words).deepEqual([]);
    should(segmentWords('!!! ').separators).deepEqual(['!!! ']);
  });
});

describe('isWholeWord', () => {
  it('accepts a complete token and rejects anything with a separator in it', () => {
    should(isWholeWord('kteam-ts')).be.true();
    should(isWholeWord('two words')).be.false();
    should(isWholeWord('')).be.false();
  });
});

describe('innerPunctuation', () => {
  it('reports the non-alphanumeric characters in order', () => {
    should(innerPunctuation("don't")).equal("'");
    should(innerPunctuation('sherpa-onnx')).equal('-');
    should(innerPunctuation('kteam')).equal('');
  });
});

describe('classifyWordChange', () => {
  it('fires the whole-word tripwire the segmenter promises never to trigger', () => {
    should(classifyWordChange('two words', 'two')).equal('word-shape-changed');
    should(classifyWordChange('two', 'two words')).equal('word-shape-changed');
  });

  it('refuses a punctuation edit smuggled inside a token', () => {
    should(classifyWordChange('dont', "don't")).equal('punctuation-changed');
  });

  it('refuses a case-only rewrite', () => {
    should(classifyWordChange('kteam', 'KTEAM')).equal('case-only-change');
  });

  it('allows a genuine whole-word substitution', () => {
    should(classifyWordChange('kteeem-ts', 'kteam-ts')).be.null();
  });
});

describe('verifyWordOnly', () => {
  it('accepts a whole-word substitution and reports it by token index', () => {
    const outcome = verifyWordOnly('use kteeem daily', 'use kteam daily');
    should(outcome.ok).be.true();
    should(outcome.changes).deepEqual([{ index: 1, from: 'kteeem', to: 'kteam' }]);
  });

  it('accepts an identity pair with no changes', () => {
    should(verifyWordOnly('same words', 'same words')).deepEqual({ ok: true, changes: [] });
  });

  it('allows letters to change around untouched inner punctuation', () => {
    const outcome = verifyWordOnly('kteeem-ts', 'kteam-ts');
    should(outcome.ok).be.true();
    should(outcome.changes).have.length(1);
  });

  it('refuses an inserted comma, because the separator bytes moved', () => {
    should(verifyWordOnly('hello there', 'hello, there').reason).equal('separator-changed');
  });

  it('refuses a collapsed double space and a smart-quote swap alike', () => {
    should(verifyWordOnly('a  b', 'a b').reason).equal('separator-changed');
    should(verifyWordOnly('say "x"', 'say “x”').reason).equal('separator-changed');
  });

  it('refuses an inserted or deleted word', () => {
    should(verifyWordOnly('one two', 'one two three').reason).equal('token-count-changed');
    should(verifyWordOnly('one two', 'one').reason).equal('token-count-changed');
  });

  it('refuses punctuation smuggled inside a word', () => {
    should(verifyWordOnly('dont', "don't").reason).equal('punctuation-changed');
    should(verifyWordOnly("don't", 'don’t').reason).equal('punctuation-changed');
    should(verifyWordOnly('sherpa-onnx', 'sherpaonnx').reason).equal('punctuation-changed');
  });

  it('refuses a change whose only effect is capitalisation', () => {
    const outcome = verifyWordOnly('hello kteam', 'hello Kteam');
    should(outcome.reason).equal('case-only-change');
    should(outcome.at).equal(1);
  });

  it('localises the failure so a log can say where', () => {
    should(verifyWordOnly('a b', 'a  b').at).equal(1);
  });

  it('refuses rather than slowly scanning an input that is a bug upstream', () => {
    const huge = 'x'.repeat(MAX_VERIFY_CHARS + 1);
    should(verifyWordOnly(huge, 'x').reason).equal('input-too-large');
    should(verifyWordOnly('x', huge).reason).equal('input-too-large');
  });
});
