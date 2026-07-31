import { describe, it } from 'bun:test';
import should from 'should';
import { firstInstantMs, instantMs, isoFromMs, latestInstantMs } from '../../../src/lib/warden/index.ts';

describe('warden instant parsing', () => {
  it.each([
    { label: 'a valid instant', value: '2026-07-30T00:00:00.000Z', expected: Date.parse('2026-07-30T00:00:00.000Z') },
    { label: 'undefined', value: undefined, expected: undefined },
    { label: 'an empty string', value: '', expected: undefined },
    { label: 'blank whitespace', value: '   ', expected: undefined },
    { label: 'unparseable text', value: 'not-a-date', expected: undefined },
  ])('should map $label to its epoch milliseconds', ({ value, expected }) => {
    // Arrange / Act
    const parsed = instantMs(value);

    // Assert
    should(parsed).eql(expected);
  });

  it('should return the latest instant of the set', () => {
    // Arrange
    const values = ['2026-07-01T00:00:00.000Z', 'nonsense', undefined, '2026-07-05T00:00:00.000Z'];

    // Act
    const latest = latestInstantMs(...values);

    // Assert
    should(latest).eql(Date.parse('2026-07-05T00:00:00.000Z'));
  });

  it('should return undefined when nothing in the set parses', () => {
    // Arrange / Act
    const latest = latestInstantMs(undefined, 'nope');

    // Assert
    should(latest).be.undefined();
  });

  it('should return the first parseable instant in priority order', () => {
    // Arrange / Act
    const first = firstInstantMs(undefined, 'nope', '2026-07-01T00:00:00.000Z', '2026-07-09T00:00:00.000Z');

    // Assert
    should(first).eql(Date.parse('2026-07-01T00:00:00.000Z'));
  });

  it('should return undefined when no candidate parses in priority order', () => {
    // Arrange / Act
    const first = firstInstantMs(undefined, '');

    // Assert
    should(first).be.undefined();
  });

  it('should render epoch milliseconds back to an ISO instant', () => {
    // Arrange
    const at = Date.parse('2026-07-30T12:34:56.000Z');

    // Act
    const rendered = isoFromMs(at);

    // Assert
    should(rendered).eql('2026-07-30T12:34:56.000Z');
  });
});
