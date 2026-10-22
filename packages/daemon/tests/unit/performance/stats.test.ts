import { describe, it } from 'bun:test';
import should from 'should';
import {
  DurationSeries,
  GaugeSeries,
  percentile,
  rate,
  round,
  SERIES_SAMPLE_LIMIT,
} from '../../../src/lib/performance/stats.ts';

describe('DurationSeries', () => {
  it('should report zeros for a series nothing was added to', () => {
    // Arrange
    const subject = new DurationSeries();
    const expected = { totalMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };

    // Act
    const actual = subject.stats();

    // Assert
    should(actual).deepEqual(expected);
    should(subject.count).equal(0);
  });

  it('should report the total, the nearest-rank percentiles and the maximum', () => {
    // Arrange
    const subject = new DurationSeries();
    const input = [40, 10, 30, 20];
    const expected = { totalMs: 100, p50Ms: 20, p95Ms: 40, maxMs: 40 };

    // Act
    for (const value of input) subject.add(value);
    const actual = subject.stats();

    // Assert
    should(actual).deepEqual(expected);
    should(subject.count).equal(4);
  });

  it('should treat a negative duration as zero', () => {
    // Arrange
    const subject = new DurationSeries();

    // Act
    subject.add(-5);
    subject.add(7);
    const actual = subject.stats();

    // Assert
    should(actual).deepEqual({ totalMs: 7, p50Ms: 0, p95Ms: 7, maxMs: 7 });
  });

  it('should round the total and maximum to two decimals', () => {
    // Arrange
    const subject = new DurationSeries();

    // Act
    subject.add(0.123);
    subject.add(0.456);
    const actual = subject.stats();

    // Assert
    should(actual.totalMs).equal(0.58);
    should(actual.maxMs).equal(0.46);
  });

  it('should keep count, total and maximum exact once past the sample limit', () => {
    // Arrange
    const subject = new DurationSeries();
    const extra = 200;

    // Act
    for (let index = 0; index < SERIES_SAMPLE_LIMIT; index += 1) subject.add(1);
    for (let index = 0; index < extra; index += 1) subject.add(500);
    const actual = subject.stats();

    // Assert
    should(subject.count).equal(SERIES_SAMPLE_LIMIT + extra);
    should(actual.totalMs).equal(SERIES_SAMPLE_LIMIT + extra * 500);
    should(actual.maxMs).equal(500);
  });

  it('should replace sampled durations deterministically once past the sample limit', () => {
    // Arrange
    const subject = new DurationSeries();

    // Act
    for (let index = 0; index < SERIES_SAMPLE_LIMIT; index += 1) subject.add(1);
    for (let index = 0; index < 200; index += 1) subject.add(500);
    const actual = subject.stats();

    // Assert
    should(actual.p50Ms).equal(1);
    should(actual.p95Ms).equal(500);
  });
});

describe('percentile', () => {
  it('should be zero for an empty list', () => {
    // Act + Assert
    should(percentile([], 0.5)).equal(0);
  });

  it.each([
    [0, 1],
    [0.25, 1],
    [0.5, 2],
    [0.75, 3],
    [1, 4],
    [2, 4],
    [-1, 1],
  ])('should take the nearest rank for fraction %s (-> %s)', (fraction, expected) => {
    // Arrange
    const input = [1, 2, 3, 4];

    // Act
    const actual = percentile(input, fraction);

    // Assert
    should(actual).equal(expected);
  });
});

describe('GaugeSeries', () => {
  it('should report zeros for a gauge never read', () => {
    // Arrange
    const subject = new GaugeSeries();

    // Act
    const actual = subject.stats();

    // Assert
    should(actual).deepEqual({ min: 0, mean: 0, max: 0 });
  });

  it('should report the minimum, mean and maximum of its readings', () => {
    // Arrange
    const subject = new GaugeSeries();

    // Act
    for (const value of [3, 1, 2, 6]) subject.add(value);
    const actual = subject.stats();

    // Assert
    should(actual).deepEqual({ min: 1, mean: 3, max: 6 });
  });

  it('should round the mean to two decimals', () => {
    // Arrange
    const subject = new GaugeSeries();

    // Act
    for (const value of [1, 1, 2]) subject.add(value);
    const actual = subject.stats();

    // Assert
    should(actual.mean).equal(1.33);
  });
});

describe('round', () => {
  it.each([
    [1.234, 1.23],
    [1.236, 1.24],
    [0, 0],
    [10, 10],
    [-1.234, -1.23],
  ])('should round %s to two decimals (-> %s)', (input, expected) => {
    // Act
    const actual = round(input);

    // Assert
    should(actual).equal(expected);
  });
});

describe('rate', () => {
  it.each([
    [10, 60_000, 60_000, 10],
    [5, 120_000, 60_000, 2.5],
    [3, 100_000, 1_000, 0.03],
    [0, 1_000, 1_000, 0],
  ])('should scale %s events over %s ms to a unit of %s ms (-> %s)', (count, windowMs, unitMs, expected) => {
    // Act
    const actual = rate(count, windowMs, unitMs);

    // Assert
    should(actual).equal(expected);
  });

  it.each([0, -1])('should be zero for a window of %s ms', windowMs => {
    // Act
    const actual = rate(10, windowMs, 1_000);

    // Assert
    should(actual).equal(0);
  });
});
