import { describe, it } from 'bun:test';
import should from 'should';
import { firstInstantMs, instantMs, isoFromMs, latestInstantMs } from '../../daemon/lib/index.ts';
import { pacificOf, resetInstantMs } from '../../daemon/lib/time.ts';

describe('the reset time of a limit', () => {
  it('should accept a real instant and refuse unset, zero, negative, infinite and non-numbers', () => {
    // Arrange / Act / Assert
    should(resetInstantMs(1_800_000_000_000)).equal(1_800_000_000_000);
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      should(resetInstantMs(bad)).be.undefined();
  });

  it('should show an instant in Pacific time, standard and daylight, never UTC', () => {
    // Arrange / Act
    const winter = pacificOf(Date.parse('2026-11-03T17:00:00.000Z'));
    const summer = pacificOf(Date.parse('2026-07-04T19:30:00.000Z'));

    // Assert
    should(winter).match(/^Nov 3, 9:00\sAM PST$/);
    should(summer).match(/^Jul 4, 12:30\sPM PDT$/);
  });
});

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
