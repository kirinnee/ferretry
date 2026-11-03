import { describe, it } from 'bun:test';
import should from 'should';
import {
  COMPACT_AT_MIN_TOKENS,
  CompactAtSchema,
  checkCompactAt,
  describeCompactAt,
  formatTokens,
  parseCompactAt,
} from '../../src/lib/index.ts';

describe('parseCompactAt', () => {
  it('should read auto and the sizes a person types', () => {
    // Act / Assert
    should(parseCompactAt(' AUTO ')).deepEqual({ ok: true, value: 'auto' });
    should(parseCompactAt('250k')).deepEqual({ ok: true, value: 250_000 });
    should(parseCompactAt('250000')).deepEqual({ ok: true, value: 250_000 });
    should(parseCompactAt('250,000')).deepEqual({ ok: true, value: 250_000 });
    should(parseCompactAt('0.4m')).deepEqual({ ok: true, value: 400_000 });
    should(parseCompactAt('1m')).deepEqual({ ok: true, value: 1_000_000 });
  });

  it('should refuse a value that is not a size, in plain words', () => {
    // Act
    const word = parseCompactAt('lots');
    const negative = parseCompactAt('-5k');

    // Assert
    should(word.ok).be.false();
    should(word.ok ? '' : word.reason).containEql('Use auto, or a token count');
    should(negative.ok).be.false();
  });

  it('should refuse a size below the floor and say what the lowest is', () => {
    // Act
    const small = parseCompactAt('50k');

    // Assert
    should(small).deepEqual({ ok: false, reason: '50k is too small: the lowest is 100k.' });
    should(parseCompactAt('100k')).deepEqual({ ok: true, value: COMPACT_AT_MIN_TOKENS });
  });
});

describe('checkCompactAt', () => {
  it('should accept auto and any size that fits the window', () => {
    // Act / Assert
    should(checkCompactAt('auto', 200_000)).be.undefined();
    should(checkCompactAt(200_000, 200_000)).be.undefined();
    should(checkCompactAt(250_000, undefined)).be.undefined();
  });

  it('should refuse a size above the model window, naming both', () => {
    // Act
    const refusal = checkCompactAt(400_000, 200_000);

    // Assert
    should(refusal).equal(
      "400k is larger than this model's 200k window, so it could never trigger. Pick 200k or less.",
    );
  });

  it('should refuse a size below the floor even when the window is unknown', () => {
    // Act / Assert
    should(checkCompactAt(99_999, undefined)).equal('99,999 is too small: the lowest is 100k.');
  });
});

describe('CompactAtSchema and the labels', () => {
  it('should store auto or an integer at or above the floor', () => {
    // Act / Assert
    should(CompactAtSchema.safeParse('auto').success).be.true();
    should(CompactAtSchema.safeParse(250_000).success).be.true();
    should(CompactAtSchema.safeParse(50_000).success).be.false();
    should(CompactAtSchema.safeParse(250_000.5).success).be.false();
    should(CompactAtSchema.safeParse('250k').success).be.false();
  });

  it('should label a value the way a surface reads it', () => {
    // Act / Assert
    should(formatTokens(250_000)).equal('250k');
    should(formatTokens(1_000_000)).equal('1m');
    should(formatTokens(1_500_000)).equal('1.5m');
    should(formatTokens(120_500)).equal('120,500');
    should(describeCompactAt('auto')).equal('Auto');
    should(describeCompactAt(400_000)).equal('400k');
  });
});
