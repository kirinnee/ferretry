import { describe, it } from 'bun:test';
import should from 'should';
import {
  applyTokenCase,
  boundedDamerauLevenshtein,
  contextVocabulary,
  type DictionaryEntry,
  enhance,
  type EnhanceInput,
  fuzzyBudget,
  looksLikeTermOfArt,
  MAX_ALIASES_PER_TERM,
  MAX_CONTEXT_VOCABULARY,
  MAX_DICTIONARY_TERMS,
  MAX_ENHANCE_CHARS,
  MAX_TERM_LENGTH,
  MAX_USER_CONTEXT_CHARS,
  MAX_USER_CONTEXT_VOCABULARY,
  MIN_CONTEXT_OCCURRENCES,
  MIN_FUZZY_LENGTH,
  nearestCandidate,
  parseDictionary,
  userContextVocabulary,
} from '../../../src/lib/stt/enhancement.ts';
import { verifyWordOnly } from '../../../src/lib/stt/word-only-verifier.ts';

const entry = (term: string, ...aliases: string[]): DictionaryEntry => ({ term, aliases });

const input = (overrides: Partial<EnhanceInput> & { text: string }): EnhanceInput => ({
  dictionary: [],
  context: [],
  ...overrides,
});

describe('boundedDamerauLevenshtein', () => {
  it('is zero for an identical pair', () => {
    should(boundedDamerauLevenshtein('kteam', 'kteam', 2)).equal(0);
  });

  it('counts a substitution, an insertion and a transposition alike', () => {
    should(boundedDamerauLevenshtein('kteem', 'kteam', 2)).equal(1);
    should(boundedDamerauLevenshtein('ktam', 'kteam', 2)).equal(1);
    should(boundedDamerauLevenshtein('ab', 'ba', 2)).equal(1);
  });

  it('refuses on a length gap alone, without scanning', () => {
    should(boundedDamerauLevenshtein('a', 'abcdefgh', 2)).equal(3);
  });

  it('abandons a row that can no longer come back under the ceiling', () => {
    should(boundedDamerauLevenshtein('aaaaaaaa', 'bbbbbbbb', 2)).equal(3);
  });

  it('measures an in-budget distance across the whole matrix', () => {
    should(boundedDamerauLevenshtein('kitten', 'sitten', 2)).equal(1);
    should(boundedDamerauLevenshtein('', 'ab', 2)).equal(2);
  });
});

describe('fuzzyBudget', () => {
  it('gives short words one edit and longer ones two', () => {
    should(fuzzyBudget(4)).equal(1);
    should(fuzzyBudget(6)).equal(1);
    should(fuzzyBudget(7)).equal(2);
  });
});

describe('looksLikeTermOfArt', () => {
  it('accepts inner capitals, digits and inner punctuation', () => {
    should(looksLikeTermOfArt('kTeam')).be.true();
    should(looksLikeTermOfArt('sha256')).be.true();
    should(looksLikeTermOfArt('sherpa-onnx')).be.true();
    should(looksLikeTermOfArt('tool_use')).be.true();
  });

  it('does not treat a sentence-initial capital as a signal', () => {
    should(looksLikeTermOfArt('Because')).be.false();
    should(looksLikeTermOfArt('ordinary')).be.false();
  });
});

describe('userContextVocabulary', () => {
  it('keeps a term of art that is mentioned exactly once', () => {
    should(userContextVocabulary('We deploy sherpa-onnx nightly.')).containEql('sherpa-onnx');
  });

  it('screens out ordinary English, which has no occurrence floor to save it', () => {
    const words = userContextVocabulary('Please check the other example before we continue.');
    should(words).not.containEql('example');
    should(words).not.containEql('please');
  });

  it('ignores words too short to fuzzy-match', () => {
    should(userContextVocabulary('cat dog eel')).deepEqual([]);
  });

  it('keeps the first spelling it saw and never repeats a word', () => {
    should(userContextVocabulary('Parakeet and parakeet again')).deepEqual(['Parakeet']);
  });

  it('says nothing for an absent or empty field', () => {
    should(userContextVocabulary(undefined)).deepEqual([]);
    should(userContextVocabulary('')).deepEqual([]);
  });

  it('truncates rather than refusing a pasted document', () => {
    const filler = 'padding '.repeat(MAX_USER_CONTEXT_CHARS);
    should(userContextVocabulary(`${filler}gpt4Only`)).not.containEql('gpt4Only');
  });

  it('stops at the vocabulary cap, keeping the front of the field', () => {
    const many = Array.from({ length: MAX_USER_CONTEXT_VOCABULARY + 30 }, (_, i) => `term${i}X`).join(' ');
    const words = userContextVocabulary(many);
    should(words).have.length(MAX_USER_CONTEXT_VOCABULARY);
    should(words[0]).equal('term0X');
  });
});

describe('contextVocabulary', () => {
  it('needs a word said more than once before trusting it', () => {
    should(contextVocabulary(['kteam once'])).deepEqual([]);
    should(contextVocabulary(['kteam here', 'kteam there'])).deepEqual(['kteam']);
  });

  it('drops stopwords and anything too short', () => {
    const words = contextVocabulary(['there there and and', 'cat cat']);
    should(words).deepEqual([]);
  });

  it('orders by frequency, then alphabetically, so the list is deterministic', () => {
    const words = contextVocabulary(['zebra zebra alpha alpha bravo bravo bravo']);
    should(words).deepEqual(['bravo', 'alpha', 'zebra']);
  });

  it('caps the mined vocabulary so a pasted log cannot slow every utterance', () => {
    const message = Array.from({ length: MAX_CONTEXT_VOCABULARY + 50 }, (_, i) => `word${i}a word${i}a`).join(' ');
    should(contextVocabulary([message])).have.length(MAX_CONTEXT_VOCABULARY);
  });

  it('requires the documented number of occurrences', () => {
    should(MIN_CONTEXT_OCCURRENCES).equal(2);
  });
});

describe('nearestCandidate', () => {
  it('finds the one candidate inside the budget', () => {
    should(nearestCandidate('kteem', ['kteam', 'fleet'], 1)).equal('kteam');
  });

  it('abstains on a tie, because a coin flip in a reader’s words is worse than silence', () => {
    should(nearestCandidate('bandy', ['candy', 'sandy'], 2)).be.null();
  });

  it('prefers the strictly nearer candidate over a further one', () => {
    should(nearestCandidate('kteem', ['kteams', 'kteam'], 2)).equal('kteam');
  });

  it('never considers a candidate too short to fuzzy-match', () => {
    should(nearestCandidate('cats', ['cat'], 2)).be.null();
    should(MIN_FUZZY_LENGTH).equal(4);
  });

  it('answers null when nothing is inside the budget', () => {
    should(nearestCandidate('kteem', ['parakeet'], 1)).be.null();
  });
});

describe('applyTokenCase', () => {
  it('carries a sentence-initial capital onto a lowercase canonical form', () => {
    should(applyTokenCase('Kteem', 'kteam')).equal('Kteam');
  });

  it('emits a canonical form that declares its own casing verbatim', () => {
    should(applyTokenCase('Gpu', 'GPU')).equal('GPU');
  });

  it('leaves a lowercase token lowercase', () => {
    should(applyTokenCase('kteem', 'kteam')).equal('kteam');
  });

  it('does not treat an all-caps token as title case', () => {
    should(applyTokenCase('KTEEM', 'kteam')).equal('kteam');
  });
});

describe('enhance', () => {
  it('substitutes a declared alias with the highest confidence', () => {
    const result = enhance(input({ text: 'run kteem now', dictionary: [entry('kteam', 'kteem')] }));
    should(result.text).equal('run kteam now');
    should(result.substitutions).deepEqual([{ index: 1, from: 'kteem', to: 'kteam', reason: 'dictionary-alias' }]);
  });

  it('recovers a near-miss against a dictionary term', () => {
    const result = enhance(input({ text: 'the paraquet model', dictionary: [entry('Parakeet')] }));
    should(result.text).equal('the Parakeet model');
    should(result.substitutions[0]?.reason).equal('dictionary-fuzzy');
  });

  it('uses the free-text context when the dictionary has nothing', () => {
    const result = enhance(input({ text: 'run parakeat now', userContext: 'parakeet is the local model' }));
    should(result.text).equal('run parakeet now');
    should(result.substitutions[0]?.reason).equal('user-context-fuzzy');
  });

  it('falls back to vocabulary mined from the conversation', () => {
    const result = enhance(input({ text: 'open the trancript', context: ['transcript here', 'the transcript again'] }));
    should(result.text).equal('open the transcript');
    should(result.substitutions[0]?.reason).equal('context-fuzzy');
  });

  it('leaves a token that already IS a dictionary term alone', () => {
    const result = enhance(input({ text: 'kteam kteam', dictionary: [entry('kteam'), entry('steam')] }));
    should(result.text).equal('kteam kteam');
    should(result.substitutions).deepEqual([]);
  });

  it('never touches a separator, so punctuation survives byte for byte', () => {
    const text = 'Hi!  "kteem",\n\tthen — done.';
    const result = enhance(input({ text, dictionary: [entry('kteam', 'kteem')] }));
    should(verifyWordOnly(text, result.text).ok).be.true();
    should(result.text).equal('Hi!  "kteam",\n\tthen — done.');
  });

  it('abstains when two dictionary terms are equally close', () => {
    const result = enhance(input({ text: 'bandy', dictionary: [entry('candy'), entry('sandy')] }));
    should(result.text).equal('bandy');
    should(result.substitutions).deepEqual([]);
  });

  it('refuses a case-only substitution rather than churning the text', () => {
    const result = enhance(input({ text: 'kteam', dictionary: [entry('KTEAM', 'kteam')] }));
    should(result.text).equal('kteam');
  });

  it('drops a candidate that would smuggle a punctuation edit inside a token', () => {
    const result = enhance(input({ text: 'sherpaonnx runs', dictionary: [entry('sherpa-onnx')] }));
    should(result.text).equal('sherpaonnx runs');
    should(result.substitutions).deepEqual([]);
  });

  it('never fuzzy-matches a token below the length floor', () => {
    should(enhance(input({ text: 'cat', dictionary: [entry('cats')] })).text).equal('cat');
  });

  it('returns the input untouched when there is nothing to do', () => {
    should(enhance(input({ text: '' })).text).equal('');
    const huge = 'word '.repeat(MAX_ENHANCE_CHARS);
    should(enhance(input({ text: huge, dictionary: [entry('kteam', 'word')] })).text).equal(huge);
  });

  it('ignores an empty term or alias in the dictionary', () => {
    const result = enhance(input({ text: 'kteem', dictionary: [entry(''), entry('kteam', '', 'kteem')] }));
    should(result.text).equal('kteam');
  });

  it('resolves a duplicated alias by first declaration, not by iteration order', () => {
    const dictionary = [entry('alpha', 'shared'), entry('bravo', 'shared')];
    should(enhance(input({ text: 'shared', dictionary })).text).equal('alpha');
  });

  it('does not let a lower tier compete with a term the reader declared', () => {
    // "kteams" is one edit from the declared term and one from the mined word,
    // which would tie and abstain if the tiers were pooled.
    const result = enhance(
      input({
        text: 'the kteamz here',
        dictionary: [entry('kteams')],
        context: ['kteamy thing', 'kteamy again'],
      }),
    );
    should(result.text).equal('the kteams here');
    should(result.substitutions[0]?.reason).equal('dictionary-fuzzy');
  });

  it('keeps a leading separator when the text starts with one', () => {
    const result = enhance(input({ text: '  kteem', dictionary: [entry('kteam', 'kteem')] }));
    should(result.text).equal('  kteam');
  });
});

describe('parseDictionary', () => {
  it('reads a bare term and a term with aliases', () => {
    const parsed = parseDictionary(['Parakeet', 'kteam = kteem, katim']);
    should(parsed.entries).deepEqual([
      { term: 'Parakeet', aliases: [] },
      { term: 'kteam', aliases: ['kteem', 'katim'] },
    ]);
    should(parsed.problems).deepEqual([]);
  });

  it('skips blanks and comments', () => {
    should(parseDictionary(['', '   ', '# a note']).entries).deepEqual([]);
  });

  it('merges a term declared on two lines instead of duplicating it', () => {
    const parsed = parseDictionary(['kteam = kteem', 'KTEAM = katim', 'kteam = kteem']);
    should(parsed.entries).deepEqual([{ term: 'kteam', aliases: ['kteem', 'katim'] }]);
  });

  it('tells the reader why a multi-word alias cannot fire', () => {
    const parsed = parseDictionary(['kteam = k team']);
    should(parsed.entries).deepEqual([{ term: 'kteam', aliases: [] }]);
    should(parsed.problems[0]).match(/spans two words/u);
  });

  it('refuses a term with a space in it', () => {
    const parsed = parseDictionary(['k team = kteam']);
    should(parsed.entries).deepEqual([]);
    should(parsed.problems[0]).match(/contains a space/u);
  });

  it('refuses a line with nothing before the equals sign', () => {
    should(parseDictionary(['= kteam']).problems[0]).match(/has no term/u);
  });

  it('refuses an over-long term or alias', () => {
    const long = 'x'.repeat(MAX_TERM_LENGTH + 1);
    should(parseDictionary([long]).problems[0]).match(/longer than/u);
    should(parseDictionary([`kteam = ${long}`]).problems[0]).match(/longer than/u);
  });

  it('caps the aliases on one term', () => {
    const aliases = Array.from({ length: MAX_ALIASES_PER_TERM + 2 }, (_, i) => `alias${i}`);
    const parsed = parseDictionary([`kteam = ${aliases.join(', ')}`]);
    should(parsed.entries[0]?.aliases).have.length(MAX_ALIASES_PER_TERM);
    should(parsed.problems[0]).match(/already has/u);
  });

  it('caps the dictionary itself', () => {
    const lines = Array.from({ length: MAX_DICTIONARY_TERMS + 3 }, (_, i) => `term${i}`);
    const parsed = parseDictionary(lines);
    should(parsed.entries).have.length(MAX_DICTIONARY_TERMS);
    should(parsed.problems[0]).match(/Only the first/u);
  });

  it('ignores an empty alias slot between commas', () => {
    should(parseDictionary(['kteam = kteem, , katim']).entries[0]?.aliases).deepEqual(['kteem', 'katim']);
  });
});
