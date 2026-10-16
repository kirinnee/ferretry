/**
 * The Parakeet vocabulary parses `<token> <id>` text the way parakeet.js does — skipping malformed
 * lines, finding the blank — and decodes token ids into clean sentence text.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { PARAKEET_BLANK_TOKEN, ParakeetVocabulary } from '../../../src/lib/stt/parakeet-vocabulary.ts';

describe('ParakeetVocabulary.parse', () => {
  it('reads one `<token> <id>` pair per line into its id slot', () => {
    const vocabulary = ParakeetVocabulary.parse('<unk> 0\n▁hello 1\nworld 2\n');
    should(vocabulary.id2token[0]).equal('<unk>');
    should(vocabulary.id2token[1]).equal('▁hello');
    should(vocabulary.id2token[2]).equal('world');
    should(vocabulary.id2token).have.length(3);
  });

  it('reads CRLF line endings the same as LF', () => {
    const vocabulary = ParakeetVocabulary.parse('a 0\r\nb 1\r\n');
    should(vocabulary.id2token).eql(['a', 'b']);
  });

  it('places tokens by id, leaving holes for ids it never saw', () => {
    const vocabulary = ParakeetVocabulary.parse('a 0\nc 2\n');
    should(vocabulary.id2token[1]).be.undefined();
    should(vocabulary.id2token[2]).equal('c');
  });

  it('skips a line with no id', () => {
    should(ParakeetVocabulary.parse('lonely\nok 0').id2token).eql(['ok']);
  });

  it('skips a line whose id is not a number', () => {
    should(ParakeetVocabulary.parse('bad xyz\nok 0').id2token).eql(['ok']);
  });

  it('skips a line whose id is negative', () => {
    const vocabulary = ParakeetVocabulary.parse('neg -1\nok 0');
    should(vocabulary.id2token).eql(['ok']);
    should(vocabulary.id2token).have.length(1);
  });

  it('skips a line with an empty token', () => {
    const vocabulary = ParakeetVocabulary.parse(' 5\nok 0');
    should(vocabulary.id2token).eql(['ok']);
  });

  it('skips blank lines and an empty file', () => {
    should(ParakeetVocabulary.parse('').id2token).eql([]);
    should(ParakeetVocabulary.parse('\n\n').id2token).eql([]);
  });
});

describe('ParakeetVocabulary blank', () => {
  it('names the blank token', () => {
    should(PARAKEET_BLANK_TOKEN).equal('<blk>');
    should(ParakeetVocabulary.parse('a 0').blankToken).equal('<blk>');
  });

  it('takes the blank id from the line that spells `<blk>`', () => {
    should(ParakeetVocabulary.parse('a 0\nb 1\n<blk> 2\nc 3').blankId).equal(2);
  });

  it('falls back to 1024 when the vocabulary has no blank', () => {
    should(ParakeetVocabulary.parse('a 0\nb 1').blankId).equal(1024);
    should(new ParakeetVocabulary([]).blankId).equal(1024);
  });
});

describe('ParakeetVocabulary.decode', () => {
  const vocabulary = ParakeetVocabulary.parse(
    ['▁hello 0', '▁world 1', ', 2', '. 3', '▁how 4', 'dy 5', '▁ 6', '! 7', '<blk> 8'].join('\n'),
  );

  it('turns `▁` into word boundaries', () => {
    should(vocabulary.decode([0, 1])).equal('hello world');
  });

  it('joins sub-word pieces without a space', () => {
    should(vocabulary.decode([4, 5])).equal('howdy');
  });

  it('trims the leading space the first word boundary leaves', () => {
    should(vocabulary.decode([0])).equal('hello');
  });

  it('puts no space before punctuation', () => {
    should(vocabulary.decode([0, 2, 1, 3])).equal('hello, world.');
    should(vocabulary.decode([0, 6, 7])).equal('hello!');
  });

  it('collapses runs of whitespace into one space', () => {
    should(vocabulary.decode([0, 6, 6, 1])).equal('hello world');
  });

  it('drops blanks', () => {
    should(vocabulary.decode([8, 0, 8, 8, 1, 8])).equal('hello world');
  });

  it('drops ids the vocabulary does not know', () => {
    should(vocabulary.decode([0, 999, 1, -3])).equal('hello world');
    should(vocabulary.decode([0, 20])).equal('hello');
  });

  it('decodes nothing to an empty string', () => {
    should(vocabulary.decode([])).equal('');
    should(vocabulary.decode([8, 8])).equal('');
  });

  it('treats the fallback blank id as blank even when the vocabulary lacks a `<blk>` line', () => {
    const noBlank = new ParakeetVocabulary(['▁a']);
    should(noBlank.decode([0, 1024])).equal('a');
  });

  it('keeps the space before a word in any script, and drops it only before punctuation', () => {
    // Parakeet v3 is multilingual; parakeet.js's ASCII rule glued every non-Latin word to the last.
    const multilingual = ParakeetVocabulary.parse('▁привет 0\n▁мир 1\n, 2\n▁école 3\n! 4');
    should(multilingual.decode([0, 2, 1, 3, 4])).equal('привет, мир école!');
  });
});
