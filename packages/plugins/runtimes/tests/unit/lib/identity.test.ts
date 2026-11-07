import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CredentialMaterial,
  type CredentialReading,
  classifyCredential,
  classifyShape,
  credentialShape,
  decideIdentity,
  decodeJwtExpiry,
  type FleetCredentialStore,
  type FleetIdentity,
  type FleetIdentityMember,
  type FleetIdentityMemberStatus,
  FleetIdentityService,
  failureMessage,
  fleetIdentityMemberOf,
  pickDonor,
} from '../../../daemon/lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../../../daemon/lib/manifest.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';
const ID_THREE = '00000000-0000-4000-8000-000000000003';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  secretEnv: {},
  id: ID_ONE,
  kind: 'claude',
  mode: 'interactive',
  wrapper: 'claude-kirin',
  home: '/homes/claude-kirin',
  displayName: 'Claude Kirin',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const member = (overrides: Partial<FleetIdentityMember> = {}): FleetIdentityMember => ({
  accountId: ID_ONE,
  wrapper: 'claude-kirin',
  home: '/homes/claude-kirin',
  displayName: 'Claude Kirin',
  mode: 'interactive',
  available: true,
  unavailableReason: null,
  ...overrides,
});

const status = (target: FleetIdentityMember, reading: CredentialReading): FleetIdentityMemberStatus => ({
  member: target,
  reading,
});

const identity = (overrides: Partial<FleetIdentity> = {}): FleetIdentity => ({
  key: 'claude:kirin',
  kind: 'claude',
  identity: 'kirin',
  auth: 'oauth',
  declared: true,
  members: [member()],
  ...overrides,
});

const found = (blob: string): CredentialMaterial => ({ outcome: 'found', blob });

/** A JWT whose `exp` claim is `seconds`. Only the payload segment is ever read. */
const jwt = (payload: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;

const claudeBlob = (credential: Record<string, unknown>): string => JSON.stringify({ claudeAiOauth: credential });

describe('decodeJwtExpiry', () => {
  it('should convert an exp claim in seconds to epoch milliseconds', () => {
    should(decodeJwtExpiry(jwt({ exp: 1_800_000_500 }))).equal(1_800_000_500_000);
  });

  it('should refuse anything that is not a string', () => {
    should(decodeJwtExpiry(undefined)).be.undefined();
    should(decodeJwtExpiry(12_345)).be.undefined();
  });

  it('should refuse a token with no payload segment', () => {
    should(decodeJwtExpiry('only-one-segment')).be.undefined();
    should(decodeJwtExpiry('header..signature')).be.undefined();
  });

  it('should refuse a payload that is not readable JSON', () => {
    should(decodeJwtExpiry('header.bm90LWpzb24.signature')).be.undefined();
  });

  it('should refuse an exp that is absent, not a number, or not positive', () => {
    should(decodeJwtExpiry(jwt({}))).be.undefined();
    should(decodeJwtExpiry(jwt({ exp: 'soon' }))).be.undefined();
    should(decodeJwtExpiry(jwt({ exp: Number.POSITIVE_INFINITY }))).be.undefined();
    should(decodeJwtExpiry(jwt({ exp: 0 }))).be.undefined();
  });
});

/**
 * The credential the harness ACTUALLY writes, pinned against its own source.
 *
 * This exists because a fleet that had just been signed in kept reporting every lane
 * `refreshable`, and the leading explanations were both about this function: that the access token
 * is not at the path it looks for, or that `expiresAt` is in seconds. Both are false, and the whole
 * point of this fixture is that it is not a guess. `@anthropic-ai/claude-code` `package/cli.js`
 * (2.0.30 and 2.1.110, the last builds that ship readable source) writes exactly one shape:
 *
 *     store.update({ claudeAiOauth: { accessToken, refreshToken, expiresAt,
 *                                     scopes, subscriptionType, rateLimitTier } })
 *
 * and assigns the expiry in exactly one shape everywhere in the bundle:
 * `expiresAt: Date.now() + (expires_in || 3600) * 1000` — epoch MILLISECONDS.
 *
 * So a credential a browser approval minted seconds ago is `valid` here, and this classifier was
 * never the thing misreading it. What was wrong was WHICH credential reached it: see
 * `keychainServices` in `adapters/credential-store.ts` for the item name the harness uses when no
 * `CLAUDE_CONFIG_DIR` names a home, and `freshlySignedIn` in `lib/login.ts` for why a login pass
 * must not accept `refreshable` as proof that its own approval landed.
 *
 * KEEP THIS FIXTURE IN THE HARNESS'S SHAPE. A fixture written to suit the reader proves that the
 * reader agrees with itself.
 */
const harnessWrittenCredential = (expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'placeholder-access-token',
      refreshToken: 'placeholder-refresh-token',
      expiresAt,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: null,
    },
  });

describe('classifyCredential for claude against the shape the harness writes', () => {
  it('should report a credential minted seconds ago as valid, never as refreshable', () => {
    // Arrange — an access token from an approval that has just completed.
    const expiresAt = NOW + 3_600_000;

    // Act
    const actual = classifyCredential('claude', found(harnessWrittenCredential(expiresAt)), NOW);

    // Assert — every extra field the harness carries is ignored rather than confusing the read.
    should(actual).deepEqual({ state: 'valid', expiresAt });
  });

  it('should read the expiry as milliseconds, which is the unit the harness stores', () => {
    // Arrange — the same instant, written the way a seconds-based reader would have to read it.
    const seconds = Math.trunc(NOW / 1000) + 3_600;

    // Act — as milliseconds it is thirty years past, so a seconds-storing harness would read dead.
    const actual = classifyCredential('claude', found(harnessWrittenCredential(seconds)), NOW);

    // Assert — it reads dead, which is exactly why the harness does not store seconds.
    should(actual).deepEqual({ state: 'refreshable', expiresAt: seconds });
    should(classifyCredential('claude', found(harnessWrittenCredential(NOW + 3_600_000)), NOW).state).equal('valid');
  });

  it('should report the same shape with a past expiry as refreshable', () => {
    // Assert — the ONLY way a harness-written credential reaches `refreshable`: it really is expired.
    should(classifyCredential('claude', found(harnessWrittenCredential(NOW - 1)), NOW)).deepEqual({
      state: 'refreshable',
      expiresAt: NOW - 1,
    });
  });
});

describe('classifyCredential for claude', () => {
  it('should report a home with no credential as missing, not unreadable', () => {
    should(classifyCredential('claude', { outcome: 'absent' }, NOW)).deepEqual({ state: 'missing' });
  });

  it('should carry a store read failure through as unreadable with its reason', () => {
    should(classifyCredential('claude', { outcome: 'unreadable', reason: 'the keychain is locked' }, NOW)).deepEqual({
      state: 'unreadable',
      reason: 'the keychain is locked',
    });
  });

  it('should treat bytes that are not readable JSON as unreadable rather than missing', () => {
    // Arrange — a credential written by a newer harness must never be overwritten as if absent.
    const actual = classifyCredential('claude', found('not json at all'), NOW);

    // Assert
    should(actual.state).equal('unreadable');
    should(actual.reason).equal('the Claude credential is not readable JSON');
  });

  it('should treat valid JSON that is not an object as unreadable', () => {
    should(classifyCredential('claude', found('[1,2,3]'), NOW).state).equal('unreadable');
    should(classifyCredential('claude', found('null'), NOW)).deepEqual({
      state: 'unreadable',
      reason: 'the Claude credential is not a JSON object',
    });
  });

  it('should report an object with neither token as missing', () => {
    should(classifyCredential('claude', found(claudeBlob({})), NOW)).deepEqual({ state: 'missing' });
  });

  it('should report a refresh token with no access token as refreshable', () => {
    should(classifyCredential('claude', found(claudeBlob({ refreshToken: 'r' })), NOW)).deepEqual({
      state: 'refreshable',
    });
  });

  it('should report an access token whose expiry cannot be read as unreadable, never as usable', () => {
    // Arrange — calling this valid would let a possibly-dead token donate to every sibling.
    const actual = classifyCredential('claude', found(claudeBlob({ accessToken: 'a', refreshToken: 'r' })), NOW);

    // Assert
    should(actual).deepEqual({
      state: 'unreadable',
      reason: 'the credential has an access token but no readable expiry',
    });
  });

  it('should ignore an expiry that is not a finite number', () => {
    should(classifyCredential('claude', found(claudeBlob({ accessToken: 'a', expiresAt: 'later' })), NOW).state).equal(
      'unreadable',
    );
  });

  it('should report an unexpired access token as valid and keep its expiry', () => {
    should(classifyCredential('claude', found(claudeBlob({ accessToken: 'a', expiresAt: NOW + HOUR })), NOW)).deepEqual(
      {
        state: 'valid',
        expiresAt: NOW + HOUR,
      },
    );
  });

  it('should count a token expiring inside the skew window as already expired', () => {
    // Arrange — a token that dies during the command that just approved it was never usable.
    const expiresAt = NOW + 30_000;

    // Act
    const actual = classifyCredential(
      'claude',
      found(claudeBlob({ accessToken: 'a', refreshToken: 'r', expiresAt })),
      NOW,
    );

    // Assert
    should(actual).deepEqual({ state: 'refreshable', expiresAt });
  });

  it('should report an expired token with no way to renew it as missing', () => {
    should(classifyCredential('claude', found(claudeBlob({ accessToken: 'a', expiresAt: NOW - HOUR })), NOW)).deepEqual(
      {
        state: 'missing',
        expiresAt: NOW - HOUR,
      },
    );
  });

  it('should read a flat credential as well as a nested one', () => {
    const flat = JSON.stringify({ accessToken: 'a', expiresAt: NOW + HOUR });
    should(classifyCredential('claude', found(flat), NOW).state).equal('valid');
  });
});

describe('classifyCredential for codex', () => {
  it('should report an auth file with no tokens block as missing', () => {
    should(classifyCredential('codex', found(JSON.stringify({})), NOW)).deepEqual({ state: 'missing' });
    should(classifyCredential('codex', found(JSON.stringify({ tokens: null })), NOW)).deepEqual({ state: 'missing' });
  });

  it('should take the expiry from the access token JWT', () => {
    // Arrange
    const material = found(
      JSON.stringify({ tokens: { access_token: jwt({ exp: (NOW + HOUR) / 1000 }), refresh_token: 'r' } }),
    );

    // Act
    const actual = classifyCredential('codex', material, NOW);

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
  });

  it('should report an expired JWT with a refresh token as refreshable', () => {
    const material = found(
      JSON.stringify({ tokens: { access_token: jwt({ exp: (NOW - HOUR) / 1000 }), refresh_token: 'r' } }),
    );
    should(classifyCredential('codex', material, NOW).state).equal('refreshable');
  });

  it('should carry an unreadable read through', () => {
    should(classifyCredential('codex', { outcome: 'unreadable', reason: 'denied' }, NOW).reason).equal('denied');
  });
});

describe('classifyCredential', () => {
  it('should dispatch on the harness kind', () => {
    // Arrange
    const claude = found(claudeBlob({ accessToken: 'a', expiresAt: NOW + HOUR }));
    const codex = found(JSON.stringify({ tokens: { access_token: jwt({ exp: (NOW + HOUR) / 1000 }) } }));

    // Assert — the same bytes would classify differently under the other reading.
    should(classifyCredential('claude', claude, NOW).state).equal('valid');
    should(classifyCredential('codex', codex, NOW).state).equal('valid');
    should(classifyCredential('codex', claude, NOW).state).equal('missing');
  });
});

describe('credentialShape and classifyShape', () => {
  it('should keep no token and no clock, so one kept shape classifies differently as time passes', () => {
    // Arrange
    const material = found(
      claudeBlob({ accessToken: 'access-TESTONLY', refreshToken: 'refresh-TESTONLY', expiresAt: NOW + HOUR }),
    );

    // Act
    const shape = credentialShape('claude', material);

    // Assert
    should(shape).deepEqual({ kind: 'tokens', hasAccess: true, hasRefresh: true, expiresAt: NOW + HOUR });
    should(JSON.stringify(shape)).not.match(/TESTONLY/);
    should(classifyShape(shape, NOW)).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
    should(classifyShape(shape, NOW + 2 * HOUR)).deepEqual({ state: 'refreshable', expiresAt: NOW + HOUR });
  });

  it.each<[string, HarnessKind, CredentialMaterial]>([
    ['an absent Claude store', 'claude', { outcome: 'absent' }],
    ['an unreadable Claude store', 'claude', { outcome: 'unreadable', reason: 'the keychain read failed (exit 36)' }],
    ['a Claude blob that is not JSON', 'claude', found('{')],
    ['a Claude blob with no tokens', 'claude', found(claudeBlob({}))],
    ['a Claude token with no expiry', 'claude', found(claudeBlob({ accessToken: 'a' }))],
    ['a Codex file with no tokens', 'codex', found(JSON.stringify({ tokens: null }))],
    ['a Codex file with only a refresh token', 'codex', found(JSON.stringify({ tokens: { refresh_token: 'r' } }))],
    [
      'a Codex token expiring now',
      'codex',
      found(JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 }) } })),
    ],
  ])('should classify %s exactly as classifyCredential does', (_case, kind, material) => {
    // Act
    const actual = classifyShape(credentialShape(kind, material), NOW);

    // Assert
    should(actual).deepEqual(classifyCredential(kind, material, NOW));
  });
});

describe('pickDonor', () => {
  it('should prefer a valid credential over a renewable one', () => {
    // Arrange
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'refreshable', expiresAt: NOW + 10 * HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'valid', expiresAt: NOW + HOUR }),
    ];

    // Act / Assert — rank beats expiry.
    should(pickDonor(members)?.member.accountId).equal(ID_TWO);
  });

  it('should prefer the furthest expiry within one state', () => {
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'valid', expiresAt: NOW + 5 * HOUR }),
    ];
    should(pickDonor(members)?.member.accountId).equal(ID_TWO);
  });

  it('should break a full tie on the account id, so the choice is deterministic', () => {
    const members = [
      status(member({ accountId: ID_TWO }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
    ];
    should(pickDonor(members)?.member.accountId).equal(ID_ONE);
  });

  it('should never pick a credential it could not read', () => {
    // Arrange — cloning one broken credential across an identity turns one broken lane into thirty.
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'unreadable', reason: 'the keychain is locked' }),
      status(member({ accountId: ID_TWO }), { state: 'missing' }),
    ];

    // Act / Assert
    should(pickDonor(members)).be.undefined();
  });

  it('should have no donor when there are no members at all', () => {
    should(pickDonor([])).be.undefined();
  });
});

describe('decideIdentity', () => {
  it('should decide an api-key identity without any credential at all', () => {
    // Act
    const actual = decideIdentity(identity({ auth: 'api-key' }), [status(member(), { state: 'missing' })], []);

    // Assert
    should(actual.verdict).deepEqual({ kind: 'no-login', reason: 'this account authenticates with a key' });
    should(actual.targets).deepEqual([]);
  });

  it('should ask for one approval when every home is positively empty', () => {
    const actual = decideIdentity(identity(), [status(member(), { state: 'missing' })], []);
    should(actual.verdict).deepEqual({ kind: 'login' });
  });

  it('should refuse to decide when nothing is usable and something could not be read', () => {
    // Arrange — "nobody is logged in" would be a guess, and the guess opens a browser for nothing.
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'missing' }),
      status(member({ accountId: ID_TWO }), { state: 'unreadable', reason: 'the keychain is locked' }),
    ];

    // Act
    const actual = decideIdentity(identity({ members: members.map(entry => entry.member) }), members, []);

    // Assert
    should(actual.verdict.kind).equal('indeterminate');
    should(actual.verdict)
      .have.property('reason')
      .match(/1 of 2 could not be read/u);
    should(actual.refused.map(entry => entry.member.accountId)).deepEqual([ID_TWO]);
  });

  it('should do nothing when every home already holds a usable credential', () => {
    // Arrange
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'valid', expiresAt: NOW + HOUR }),
    ];

    // Act
    const actual = decideIdentity(identity(), members, []);

    // Assert
    should(actual.verdict).deepEqual({ kind: 'complete' });
    should(actual.targets).deepEqual([]);
  });

  it('should copy the donor onto the siblings that need one', () => {
    // Arrange
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'missing' }),
      status(member({ accountId: ID_THREE }), { state: 'refreshable', expiresAt: NOW - HOUR }),
    ];

    // Act
    const actual = decideIdentity(identity(), members, []);

    // Assert — an expired-but-renewable sibling is refreshed from the healthier copy.
    should(actual.verdict).deepEqual({ kind: 'sync', donor: members[0]?.member as FleetIdentityMember });
    should(actual.targets.map(entry => entry.accountId)).deepEqual([ID_TWO, ID_THREE]);
  });

  it('should refuse a sibling whose own credential could not be read, and still sync the others', () => {
    // Arrange
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'missing' }),
      status(member({ accountId: ID_THREE }), { state: 'unreadable', reason: 'the keychain is locked' }),
    ];

    // Act
    const actual = decideIdentity(identity(), members, []);

    // Assert — an unreadable home is never overwritten, but it does not block its siblings either.
    should(actual.verdict.kind).equal('sync');
    should(actual.targets.map(entry => entry.accountId)).deepEqual([ID_TWO]);
    should(actual.refused.map(entry => entry.member.accountId)).deepEqual([ID_THREE]);
  });

  it('should report a donor whose siblings are all valid as complete, keeping any refusal', () => {
    // Arrange
    const members = [
      status(member({ accountId: ID_ONE }), { state: 'valid', expiresAt: NOW + HOUR }),
      status(member({ accountId: ID_TWO }), { state: 'unreadable', reason: 'denied' }),
    ];

    // Act
    const actual = decideIdentity(identity(), members, []);

    // Assert
    should(actual.verdict).deepEqual({ kind: 'complete' });
    should(actual.refused.map(entry => entry.member.accountId)).deepEqual([ID_TWO]);
  });

  it('should carry unavailable members through untouched', () => {
    const skipped = member({ accountId: ID_THREE, available: false, unavailableReason: 'the harness is missing' });
    const actual = decideIdentity(identity(), [status(member(), { state: 'missing' })], [skipped]);
    should(actual.unavailable).deepEqual([skipped]);
  });
});

/** A store driven entirely from a table, so no test reads or writes a real credential. */
class FakeCredentialStore implements FleetCredentialStore {
  readonly reads: string[] = [];

  constructor(
    private readonly readings: Readonly<Record<string, CredentialReading>>,
    private readonly failures: Readonly<Record<string, string>> = {},
  ) {}

  read(_kind: HarnessKind, target: FleetIdentityMember): Promise<CredentialReading> {
    this.reads.push(target.accountId);
    const thrown = this.failures[target.accountId];
    if (thrown !== undefined) return Promise.reject(new Error(thrown));
    return Promise.resolve(this.readings[target.accountId] ?? { state: 'missing' });
  }
}

describe('FleetIdentityService', () => {
  const twoMembers = [member({ accountId: ID_ONE }), member({ accountId: ID_TWO })];

  it('should read every available home and decide from what it found', async () => {
    // Arrange
    const store = new FakeCredentialStore({
      [ID_ONE]: { state: 'valid', expiresAt: NOW + HOUR },
      [ID_TWO]: { state: 'missing' },
    });
    const subject = new FleetIdentityService(store);

    // Act
    const actual = await subject.surveyOne(identity({ members: twoMembers }));

    // Assert
    should(store.reads.sort()).deepEqual([ID_ONE, ID_TWO]);
    should(actual.verdict.kind).equal('sync');
  });

  it('should never read a credential for an api-key identity', async () => {
    // Arrange
    const store = new FakeCredentialStore({});
    const subject = new FleetIdentityService(store);

    // Act
    const actual = await subject.surveyOne(identity({ auth: 'api-key', members: twoMembers }));

    // Assert — looking for a credential that does not exist is the tool inventing work.
    should(store.reads).deepEqual([]);
    should(actual.verdict.kind).equal('no-login');
  });

  it('should not read a home the manifest declares unavailable', async () => {
    // Arrange
    const store = new FakeCredentialStore({ [ID_ONE]: { state: 'valid', expiresAt: NOW + HOUR } });
    const members = [
      member({ accountId: ID_ONE }),
      member({ accountId: ID_TWO, available: false, unavailableReason: 'no harness' }),
    ];

    // Act
    const actual = await new FleetIdentityService(store).surveyOne(identity({ members }));

    // Assert
    should(store.reads).deepEqual([ID_ONE]);
    should(actual.unavailable.map(entry => entry.accountId)).deepEqual([ID_TWO]);
  });

  it('should treat a store that throws as a read that failed, not a home with no credential', async () => {
    // Arrange
    const store = new FakeCredentialStore({}, { [ID_ONE]: 'the keychain timed out' });

    // Act
    const actual = await new FleetIdentityService(store).surveyOne(identity({ members: [member()] }));

    // Assert
    should(actual.members[0]?.reading).deepEqual({ state: 'unreadable', reason: 'the keychain timed out' });
    should(actual.verdict.kind).equal('indeterminate');
  });
});

describe('failureMessage', () => {
  it('should use the error message when there is one', () => {
    should(failureMessage(new Error('the keychain is locked'), 'fallback')).equal('the keychain is locked');
  });

  it('should use the fallback for an empty message or a value that is not an error', () => {
    should(failureMessage(new Error(''), 'fallback')).equal('fallback');
    should(failureMessage('a string', 'fallback')).equal('fallback');
  });
});

describe('fleetIdentityMemberOf', () => {
  it('should carry every field a credential store or a login needs from a published account', () => {
    // Act
    const actual = fleetIdentityMemberOf(account({ available: false, unavailableReason: 'paused' }));

    // Assert
    should(actual).deepEqual(member({ available: false, unavailableReason: 'paused' }));
  });
});
