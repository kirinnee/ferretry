/**
 * Pins how the noise harness judges a turn the endpointer ended early. The rule under test: a cut-off
 * "by design" needs the person to have been quiet for the WHOLE configured pause; anything shorter is
 * a false send, and a gap within the published tolerance is additionally flagged as a near miss.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { judge, NEAR_MISS_MS, realGapMs, type Word } from '../../../harness/turn-endpointer-scoring.ts';

const LOUD = 0.1;
const QUIET = 0.001;
const STEP = 20;

/** `[level, ms]` runs as 20 ms frame levels. */
const levelsOf = (runs: readonly (readonly [number, number])[]): number[] =>
  runs.flatMap(([level, ms]) => Array.from({ length: ms / STEP }, () => level));

describe('realGapMs', () => {
  const words: Word[] = [
    { startMs: 0, endMs: 2_000 },
    { startMs: 3_400, endMs: 5_000 },
  ];
  it('is the real quiet around the middle of the measured quiet', () => {
    should(realGapMs(words, 3_500, 1_500)).equal(1_400);
  });
  it('is 0 when the middle falls inside a word', () => {
    should(realGapMs(words, 4_500, 1_500)).equal(0);
  });
  it('is 0 when no word follows the middle', () => {
    should(realGapMs(words.slice(0, 1), 3_500, 1_500)).equal(0);
  });
});

describe('judge scores against the configured pause', () => {
  // The talker is quiet for `gapMs` after 2 s of speech, but the part of the next word the
  // endpointer cannot hear (under the threshold) keeps the level quiet until 3.5 s.
  const play = (gapMs: number) => {
    const words: Word[] = [
      { startMs: 0, endMs: 2_000 },
      { startMs: 2_000 + gapMs, endMs: 5_000 },
    ];
    const levels = levelsOf([
      [LOUD, 2_000],
      [QUIET, 1_500],
      [LOUD, 1_500],
    ]);
    return judge(levels, words, 0, 'normal');
  };

  it('a true 1400 ms gap at Normal that the detector ended on is a false send, not a cut-off', () => {
    const outcome = play(1_400);
    should(outcome.falseSend).be.true();
    should(outcome.cutOff).be.false();
    should(outcome.nearMiss).be.true();
  });

  it('a gap of exactly the pause is the person pausing as long as the setting: a cut-off', () => {
    const outcome = play(1_500);
    should(outcome.cutOff).be.true();
    should(outcome.falseSend).be.false();
    should(outcome.nearMiss).be.false();
  });

  it('a gap just outside the tolerance is a false send and not a near miss', () => {
    const outcome = play(1_500 - NEAR_MISS_MS - STEP);
    should(outcome.falseSend).be.true();
    should(outcome.nearMiss).be.false();
  });

  it('a gap exactly at the tolerance edge is a near miss', () => {
    should(play(1_500 - NEAR_MISS_MS).nearMiss).be.true();
  });

  it('speech that read as quiet (the middle falls inside a word) is a false send, not a near miss', () => {
    const words: Word[] = [{ startMs: 0, endMs: 5_000 }];
    const levels = levelsOf([
      [LOUD, 1_000],
      [QUIET, 1_600],
      [LOUD, 1_500],
    ]);
    const outcome = judge(levels, words, 0, 'normal');
    should(outcome.falseSend).be.true();
    should(outcome.nearMiss).be.false();
  });

  it('a turn that ends after the last word is neither', () => {
    const outcome = judge(
      levelsOf([
        [LOUD, 2_000],
        [QUIET, 2_000],
      ]),
      [{ startMs: 0, endMs: 2_000 }],
      0,
      'normal',
    );
    should(outcome.falseSend).be.false();
    should(outcome.cutOff).be.false();
    should(outcome.late).be.false();
    should(outcome.lateByMs).equal(0);
  });
});
