import { describe, it } from 'bun:test';
import should from 'should';
import { decodeParameter, headerValue, queryFrom, queryValue, queryValues } from '../../../src/lib/api/index.ts';
import { request } from './support.ts';

describe('header access', () => {
  it('should read a header regardless of the case it was sent in', () => {
    // Arrange
    const subject = request({ headers: { AuThOrIzAtIoN: 'Bearer x' } });

    // Act / Assert
    should(headerValue(subject, 'authorization')).equal('Bearer x');
    should(headerValue(subject, 'AUTHORIZATION')).equal('Bearer x');
  });

  it('should report an absent header as undefined', () => {
    // Arrange / Act / Assert
    should(headerValue(request(), 'authorization')).be.undefined();
  });
});

describe('query access', () => {
  it('should keep every value of a repeated key in order', () => {
    // Arrange
    const subject = request({
      query: [
        ['sessionId', 'a'],
        ['sessionId', 'b'],
      ],
    });

    // Act / Assert
    should(queryValues(subject, 'sessionId')).deepEqual(['a', 'b']);
  });

  it('should take the first value for a single-valued read', () => {
    // Arrange
    const subject = request({
      query: [
        ['after', '10'],
        ['after', '20'],
      ],
    });

    // Act / Assert
    should(queryValue(subject, 'after')).equal('10');
  });

  it('should report an absent key as an empty list and undefined', () => {
    // Arrange / Act / Assert
    should(queryValues(request(), 'missing')).deepEqual([]);
    should(queryValue(request(), 'missing')).be.undefined();
  });

  it('should build the map from repeated pairs', () => {
    // Arrange / Act
    const query = queryFrom([
      ['a', '1'],
      ['b', '2'],
      ['a', '3'],
    ]);

    // Assert
    should(query.get('a')).deepEqual(['1', '3']);
    should(query.get('b')).deepEqual(['2']);
  });
});

describe('decodeParameter', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ['plain', 'plain'],
    ['with%20space', 'with space'],
    ['%2e%2e', undefined],
    ['..', undefined],
    ['.', undefined],
    ['%2f', undefined],
    ['a%2fb', undefined],
    ['a%5cb', undefined],
    ['a%00b', undefined],
    ['%zz', undefined],
    ['%', undefined],
  ];

  for (const [raw, expected] of cases) {
    it(`should decode "${raw}" to ${String(expected)}`, () => {
      // Arrange / Act / Assert
      should(decodeParameter(raw)).equal(expected);
    });
  }
});
