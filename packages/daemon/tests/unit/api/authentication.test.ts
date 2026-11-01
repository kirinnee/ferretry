import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { CredentialAgentIdentities, type CredentialedSession } from '../../../src/lib/agent-tools/policy.ts';
import {
  authenticate,
  bearerToken,
  isPreKeyDeviceToken,
  isSessionCredential,
  presentToken,
  type SessionCredentialDirectory,
  secretsMatch,
} from '../../../src/lib/api/index.ts';

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
  const credentials = {
    admin: 'admin-secret',
    warden: 'warden-secret',
  };

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

  it('should resolve no device from anything a request can send', () => {
    // A device is whoever its SESSION proved; there is no bearer that names one any more. Even a value
    // shaped exactly like an old device token is a stranger here.
    const oldToken = `fy_device_${'d'.repeat(43)}`;
    should(authenticate(credentials, { bearer: oldToken })).deepEqual({ kind: 'anonymous' });
  });

  it('should read a token from the bearer alone, never from a query parameter', () => {
    // A token in a URL reaches argv, shell history and every proxy's access log. A caller that still
    // hands one over — whatever field it uses — is a stranger.
    // Arrange
    const queried = { query: 'admin-secret' } as unknown as Parameters<typeof authenticate>[1];

    // Act
    const result = authenticate(credentials, queried);

    // Assert
    should(result).deepEqual({ kind: 'anonymous' });
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

describe('isPreKeyDeviceToken', () => {
  it('should recognise only the exact shape of a device token from before device keys', () => {
    should(isPreKeyDeviceToken(`fy_device_${'d'.repeat(43)}`)).be.true();
    should(isPreKeyDeviceToken(`fy_device_${'d'.repeat(42)}`)).be.false();
    should(isPreKeyDeviceToken(`fy_device_id_${'d'.repeat(22)}`)).be.false();
    should(isPreKeyDeviceToken('admin-secret')).be.false();
    should(isPreKeyDeviceToken(undefined)).be.false();
  });
});

/** A session credential as the daemon mints one now: the prefix and 43 base64url characters. */
const sessionCredential = (fill: string) => `fys_${fill.repeat(43)}`;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The directory the daemon builds — the agent tools' own resolver over the session documents, with the
 * constant-time matcher — so these cases prove the lookup that runs, not a stand-in for it.
 */
function directoryOver(sessions: readonly CredentialedSession[]) {
  const asked: string[] = [];
  const compared: (readonly [string, string])[] = [];
  const identities = new CredentialAgentIdentities({ snapshot: async () => sessions }, sha256, (left, right) => {
    compared.push([left, right]);
    return secretsMatch(left, right);
  });
  const directory: SessionCredentialDirectory = {
    resolve: async capability => {
      asked.push(capability);
      return await identities.resolve(capability);
    },
  };
  return { directory, asked, compared };
}

const LIVE = sessionCredential('a');
const STOPPED = sessionCredential('b');
const SESSIONS: readonly CredentialedSession[] = [
  { id: 'session-live', name: null, active: true, sessionCapabilityHash: sha256(LIVE) },
  { id: 'session-stopped', name: null, active: false, sessionCapabilityHash: sha256(STOPPED) },
];

describe('isSessionCredential', () => {
  it('should recognise only the prefix followed by exactly 43 base64url characters', () => {
    should(isSessionCredential(sessionCredential('a'))).be.true();
    should(isSessionCredential(`fys_${'-_aZ09'.repeat(7)}x`)).be.true();
    should(isSessionCredential(`fys_${'a'.repeat(42)}`)).be.false();
    should(isSessionCredential(`fys_${'a'.repeat(44)}`)).be.false();
    should(isSessionCredential(`fyx_${'a'.repeat(43)}`)).be.false();
    should(isSessionCredential(`fys_${'a'.repeat(42)}=`)).be.false();
    should(isSessionCredential('a'.repeat(43))).be.false();
    should(isSessionCredential(undefined)).be.false();
  });
});

describe('the session credential', () => {
  const credentials = { admin: 'admin-secret', warden: 'warden-secret' };

  it('should authenticate as the active session it was minted for', async () => {
    // Arrange
    const { directory } = directoryOver(SESSIONS);

    // Act
    const presented = await presentToken({ ...credentials, sessions: directory }, LIVE);

    // Assert
    should(authenticate(credentials, presented)).deepEqual({
      kind: 'authenticated',
      tokenClass: 'session',
      sessionId: 'session-live',
    });
  });

  it('should be anonymous once its session has stopped, ended or gone — the lookup reads only what is active', async () => {
    // Arrange — `active: false` is every status a session never leaves (stopped, completed, failed, …);
    // a deleted session is simply not in the snapshot.
    const { directory } = directoryOver(SESSIONS);
    const gone = directoryOver([]);

    // Act
    const stopped = await presentToken({ ...credentials, sessions: directory }, STOPPED);
    const deleted = await presentToken({ ...credentials, sessions: gone.directory }, LIVE);

    // Assert
    should(authenticate(credentials, stopped)).deepEqual({ kind: 'anonymous' });
    should(authenticate(credentials, deleted)).deepEqual({ kind: 'anonymous' });
  });

  it('should compare hashes, never the value, with the constant-time matcher', async () => {
    // Arrange
    const { directory, compared } = directoryOver(SESSIONS);

    // Act
    await presentToken({ ...credentials, sessions: directory }, sessionCredential('z'));

    // Assert — only the active session's stored hash is consulted, against the digest of what was sent.
    should(compared).deepEqual([[sha256(LIVE), sha256(sessionCredential('z'))]]);
  });

  it('should answer a value of the wrong prefix or length from its shape, without a lookup', async () => {
    // Arrange — even the live credential's own characters, under the wrong prefix or a byte short.
    const { directory, asked } = directoryOver(SESSIONS);
    const withSessions = { ...credentials, sessions: directory };
    const shapes = [
      `fyx_${'a'.repeat(43)}`,
      `fys_${'a'.repeat(42)}`,
      `fys_${'a'.repeat(44)}`,
      'a'.repeat(43),
      'admin-secret',
    ];

    // Act
    const results = await Promise.all(
      shapes.map(async shape => authenticate(withSessions, await presentToken(withSessions, shape))),
    );

    // Assert
    should(results.filter(result => result.kind === 'authenticated')).deepEqual([
      { kind: 'authenticated', tokenClass: 'admin' },
    ]);
    should(asked).deepEqual([]);
  });

  it('should be anonymous when no directory can answer, or the one there fails', async () => {
    // Arrange
    const failing: SessionCredentialDirectory = { resolve: async () => await Promise.reject(new Error('disk')) };

    // Act
    const none = await presentToken(credentials, LIVE);
    const failed = await presentToken({ ...credentials, sessions: failing }, LIVE);

    // Assert
    should(authenticate(credentials, none)).deepEqual({ kind: 'anonymous' });
    should(authenticate(credentials, failed)).deepEqual({ kind: 'anonymous' });
  });

  it('should use an answer only for the exact value it was given for', () => {
    // An answer for one value, carried beside a different bearer, proves nothing about that bearer.
    // Arrange
    const answer = { capability: LIVE, sessionId: 'session-live' };

    // Act / Assert
    should(authenticate(credentials, { bearer: STOPPED, session: answer })).deepEqual({ kind: 'anonymous' });
    should(authenticate(credentials, { bearer: 'guess', session: answer })).deepEqual({ kind: 'anonymous' });
    should(authenticate(credentials, { session: answer })).deepEqual({ kind: 'anonymous' });
    should(authenticate(credentials, { bearer: LIVE, session: answer })).match({ tokenClass: 'session' });
  });

  it('should still let the admin token win over anything a session answer says', () => {
    // Arrange / Act
    const result = authenticate(credentials, {
      bearer: 'admin-secret',
      session: { capability: 'admin-secret', sessionId: 'session-live' },
    });

    // Assert
    should(result).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
  });
});
