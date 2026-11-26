import { describe, expect, test } from 'bun:test';
import { splitForSpeech, spokenNumbers } from '../../../daemon/lib/reply/chunks.ts';
import { resample24to16 } from '../../../daemon/lib/reply/resample.ts';

describe('a spoken line as pieces', () => {
  test('a short line is one piece, folded', () => {
    expect(splitForSpeech('  Let me   check\nthe failing test. ')).toEqual(['Let me check the failing test.']);
  });

  test('each sentence is a piece, and the closing quote stays with its sentence', () => {
    expect(splitForSpeech('I found it. Is that "fixed?" Yes!')).toEqual(['I found it.', 'Is that "fixed?"', 'Yes!']);
  });

  test('a long first sentence without commas starts at a natural clause boundary', () => {
    expect(
      splitForSpeech('I looked through the logs and the build failed because one dependency was missing.'),
    ).toEqual(['I looked through the logs and the build failed', 'because one dependency was missing.']);
  });

  test('bounds unpunctuated speech without losing words or leaving a tiny tail', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    const pieces = splitForSpeech(text);
    expect(pieces.map(piece => piece.split(' ').length)).toEqual([11, 3]);
    expect(pieces.join(' ')).toBe(text);
  });

  test('a long sentence is cut at its commas, and a clause that is too short joins its neighbour', () => {
    const pieces = splitForSpeech('I found the bug, it was a missing await in the send path, and I have fixed it now.');
    expect(pieces).toEqual([
      'I found the bug,',
      'it was a missing await in the send path,',
      'and I have fixed it now.',
    ]);
    expect(
      splitForSpeech('Yes, I have checked the whole build and all of the tests across the repository today.'),
    ).toEqual(['Yes, I have checked the whole build', 'and all of the tests across the repository today.']);
    // A trailing clause with one word joins the one before it.
    expect(splitForSpeech('I have checked the whole build and all of the tests across the repository, ok.')).toEqual([
      'I have checked the whole build',
      'and all of the tests across the repository, ok.',
    ]);
  });

  test('a piece with no letters or numbers is not spoken, and nothing is no pieces', () => {
    expect(splitForSpeech('...')).toEqual([]);
    expect(splitForSpeech('')).toEqual([]);
    expect(splitForSpeech('Done. ... 42.')).toEqual(['Done.', 'forty two.']);
  });

  test('a piece with no punctuation at all is cut at a space when it is very long', () => {
    const pieces = splitForSpeech('word '.repeat(200).trim());
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(280);
    expect(pieces.join(' ')).toBe('word '.repeat(200).trim());
    // Nowhere to cut at a space: cut at the limit.
    expect(splitForSpeech('x'.repeat(600)).map(piece => piece.length)).toEqual([280, 280, 40]);
  });
});

describe('numbers are written out, because the voice has no digits', () => {
  test('whole numbers, with and without grouping', () => {
    expect(spokenNumbers('0 and 7 and 13 and 20 and 42')).toBe('zero and seven and thirteen and twenty and forty two');
    expect(spokenNumbers('100, 101 and 999')).toBe('one hundred, one hundred one and nine hundred ninety nine');
    expect(spokenNumbers('1,204 tests ran')).toBe('one thousand two hundred four tests ran');
    expect(spokenNumbers('2026')).toBe('two thousand twenty six');
    expect(spokenNumbers('3,000,000')).toBe('three million');
    expect(spokenNumbers('1,000,000,001')).toBe('one billion one');
    expect(spokenNumbers('2,000,000,000,000')).toBe('two trillion');
  });

  test('decimals, percentages, and a number too big to say are read sensibly', () => {
    expect(spokenNumbers('3.5 seconds')).toBe('three point five seconds');
    expect(spokenNumbers('0.25')).toBe('zero point two five');
    expect(spokenNumbers('50% done')).toBe('fifty percent done');
    expect(spokenNumbers('12.5%')).toBe('twelve point five percent');
    expect(spokenNumbers('1234567890123456789')).toBe(
      'one two three four five six seven eight nine zero one two three four five six seven eight nine',
    );
  });

  test('a number glued to letters (an id, an ordinal) is left alone, and a trailing sentence stop is kept', () => {
    expect(spokenNumbers('the 1st and abc123 and 3d')).toBe('the 1st and abc123 and 3d');
    expect(splitForSpeech('I ran 3 tests. 2 failed.')).toEqual(['I ran three tests.', 'two failed.']);
  });
});

describe('24 kHz to 16 kHz', () => {
  const sine = (hz: number, rate: number, seconds: number): Float32Array =>
    Float32Array.from(
      { length: Math.round(rate * seconds) },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * hz * index) / rate),
    );
  const rms = (samples: Float32Array, from = 0, to = samples.length): number => {
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += (samples[index] ?? 0) ** 2;
    return Math.sqrt(sum / (to - from));
  };

  test('two thirds as many samples, and nothing for nothing', () => {
    expect(resample24to16(new Float32Array(24_000))).toHaveLength(16_000);
    expect(resample24to16(new Float32Array(0))).toHaveLength(0);
    expect(resample24to16(new Float32Array(2))).toHaveLength(1);
  });

  test('keeps a speech-band tone at its level and removes one above the new rate’s limit', () => {
    const kept = resample24to16(sine(1_000, 24_000, 1));
    // Away from the edges, a 0.5-amplitude sine keeps its RMS (0.354).
    expect(rms(kept, 400, 15_600)).toBeGreaterThan(0.34);
    expect(rms(kept, 400, 15_600)).toBeLessThan(0.37);
    const gone = resample24to16(sine(10_000, 24_000, 1));
    expect(rms(gone, 400, 15_600)).toBeLessThan(0.02);
  });

  test('the tone keeps its pitch: 1 kHz in is 1 kHz out', () => {
    const out = resample24to16(sine(1_000, 24_000, 1));
    let crossings = 0;
    for (let index = 1; index < out.length; index += 1)
      if ((out[index - 1] ?? 0) < 0 && (out[index] ?? 0) >= 0) crossings += 1;
    expect(Math.abs(crossings - 1_000)).toBeLessThanOrEqual(2);
  });

  test('a steady level is the same level', () => {
    const out = resample24to16(new Float32Array(24_000).fill(0.25));
    expect(out[8_000]).toBeCloseTo(0.25, 3);
    expect(out[8_001]).toBeCloseTo(0.25, 3);
  });
});
