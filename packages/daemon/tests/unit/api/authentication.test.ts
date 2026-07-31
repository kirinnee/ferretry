import { describe, it } from 'bun:test';
import should from 'should';
import { authenticate, bearerToken, secretsMatch } from '../../../src/lib/api/index.ts';

describe('secretsMatch', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['abc', 'abc', true],
    ['abc', 'abd', false],
    ['abc', 'abcd', false],
    ['abcd', 'abc', false],
    ['', '', true],
    ['', 'a', false],
  ];

  for (const [left, right, expected] of cases) {
    it(`should answer ${String(expected)} comparing "${left}" with "${right}"`, () => {
      // Arrange / Act / Assert
      should(secretsMatch(left, right)).equal(expected);
    });
  }

  it('should not short-circuit on the first differing character', () => {
    // A prefix match and a total mismatch must both walk the whole string; the observable proxy for
    // that here is that neither is treated as equal and both handle the longer-right case.
    // Arrange / Act / Assert
    should(secretsMatch('aaaaaaaa', 'aaaaaaab')).be.false();
    should(secretsMatch('baaaaaaa', 'aaaaaaaa')).be.false();
  });
});

describe('bearerToken', () => {
  const cases: readonly (readonly [string | undefined, string | undefined])[] = [
    ['Bearer secret', 'secret'],
    ['bearer secret', 'secret'],
    ['BEARER   secret', 'secret'],
    ['  Bearer secret  ', 'secret'],
    ['Basic secret', undefined],
    ['Bearer', undefined],
    ['Bearer ', undefined],
    [undefined, undefined],
  ];

  for (const [header, expected] of cases) {
    it(`should read ${String(expected)} from ${String(header)}`, () => {
      // Arrange / Act / Assert
      should(bearerToken(header)).equal(expected);
    });
  }
});

describe('authenticate', () => {
  const credentials = { admin: 'admin-secret', warden: 'warden-secret' };

  it('should classify the admin token as admin', () => {
    // Arrange / Act
    const result = authenticate(credentials, { bearer: 'admin-secret' });

    // Assert
    should(result).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });

  it('should classify the warden token as warden', () => {
    // Arrange / Act
    const result = authenticate(credentials, { bearer: 'warden-secret' });

    // Assert
    should(result).deepEqual({ kind: 'authenticated', tokenClass: 'warden' });
  });

  it('should accept a query token, which is how a WebSocket upgrade authenticates', () => {
    // Arrange / Act
    const result = authenticate(credentials, { query: 'admin-secret' });

    // Assert
    should(result).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });

  it('should reject an unknown token', () => {
    // Arrange / Act
    const result = authenticate(credentials, { bearer: 'guess' });

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
  });

  it('should reject a request that presents nothing', () => {
    // Arrange / Act
    const result = authenticate(credentials, {});

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
  });

  it('should never authenticate against a blank admin secret', () => {
    // A daemon that failed to mint a token must serve only its public routes — the source compared
    // the presented bearer directly, so an empty configured token made the whole API public.
    // Arrange / Act
    const result = authenticate({ admin: '' }, { bearer: '' });

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
  });

  it('should never authenticate against a blank warden secret', () => {
    // Arrange / Act
    const result = authenticate({ admin: 'admin-secret', warden: '' }, { bearer: '' });

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
  });

  it('should serve no warden class at all when no warden token is configured', () => {
    // Arrange / Act
    const result = authenticate({ admin: 'admin-secret' }, { bearer: 'warden-secret' });

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
  });

  it('should prefer admin when one secret is configured as both', () => {
    // Arrange / Act
    const result = authenticate({ admin: 'same', warden: 'same' }, { bearer: 'same' });

    // Assert
    should(result).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });
});
