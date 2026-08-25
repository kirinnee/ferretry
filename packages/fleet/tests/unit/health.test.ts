import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import {
  buildFleetHealthCollector,
  decideAccountHealth,
  FLEET_HEALTH_FRESH_MS,
  type FleetCredentialClassifier,
  healthSnapshotFromObservations,
  type LocalCredentialReading,
  observeAccountHealth,
  readLocalCredentials,
} from '../../src/lib/health.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import type { FleetCredentialSignal, FleetUsageSnapshot } from '../../src/lib/usage.ts';

const NOW = 1_786_000_000_000;
const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

const account = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  kind: 'claude',
  mode: 'auto',
  wrapper: `fy-${id}`,
  home: `/tmp/${id}`,
  displayName: id,
  models: [],
  available: true,
  unavailableReason: null,
  ...patch,
});

const manifest = (accounts: readonly Record<string, unknown>[]): FleetManifest =>
  ({ version: 1, generatedAt: '2026-08-05T00:00:00.000Z', accounts }) as unknown as FleetManifest;

/** Parse rather than hand-build, so a case runs against configuration somebody could write. */
const config = (input: Record<string, unknown> = {}): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(`fixture is not valid configuration: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
};

/** A fleet declaring one account, with whatever credential source the case needs. */
const declared = (fixture: { env?: Record<string, string>; auth?: 'oauth' | 'api-key' } = {}) =>
  config({
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        ...(fixture.auth === undefined ? {} : { auth: fixture.auth }),
        ...(fixture.env === undefined ? {} : { env: fixture.env }),
        routes: {
          default: {
            id: ID_ONE,
            wrapper: 'claude-kirin',
            home: 'claude-kirin',
            defaultModel: 'model-one',
            models: ['model-one'],
          },
        },
      },
    ],
  });

const usage = (
  rows: readonly { id: string; signal?: FleetCredentialSignal; responseFingerprint?: unknown }[],
): FleetUsageSnapshot =>
  ({
    at: NOW,
    accounts: rows.map(row => ({
      accountId: row.id,
      kind: 'claude',
      usageBased: true,
      ok: true,
      unavailable: false,
      atLimit: false,
      ...(row.signal === undefined ? {} : { credentialSignal: row.signal }),
      ...(row.responseFingerprint === undefined ? {} : { responseFingerprint: row.responseFingerprint }),
    })),
  }) as unknown as FleetUsageSnapshot;

describe('decideAccountHealth', () => {
  const input = (patch: Partial<Parameters<typeof decideAccountHealth>[0]> = {}) =>
    decideAccountHealth({
      kind: 'claude',
      loginApplies: true,
      available: true,
      local: undefined,
      remote: undefined,
      ...patch,
    });

  it('checks nothing about an account the manifest declares unavailable', () => {
    // Arrange / Act
    const actual = input({ available: false, remote: 'accepted' });

    // Assert — a credential verdict about an unavailable account would be a claim nothing measured,
    // and it must not be conclusive or it would outlive the manifest that produced it.
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'account_unavailable',
      evidence: 'none',
      conclusive: false,
    });
  });

  it('treats a 403 from the read-only usage endpoint as HEALTHY', () => {
    // Arrange / Act
    const actual = input({ remote: 'scope_unavailable' });

    // Assert — THE rule this feature turns on. A 403 means the token lacks `user:profile`, which is
    // permanent for an inference-scoped token; reading it as a rejection sends somebody to re-login
    // forever on a working account.
    should(actual).deepEqual({
      verdict: 'healthy',
      reason: 'usage_scope_unavailable',
      evidence: 'anthropic_usage',
      conclusive: true,
    });
  });

  it('is healthy and conclusive when the provider accepted the token', () => {
    should(input({ remote: 'accepted' })).deepEqual({
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      conclusive: true,
    });
  });

  it('needs a re-login when the provider rejected the token and a login could fix it', () => {
    should(input({ remote: 'rejected' })).deepEqual({
      verdict: 'needs_relogin',
      reason: 'oauth_token_rejected',
      evidence: 'anthropic_usage',
      conclusive: true,
    });
  });

  it('needs a CREDENTIAL, never a login, when no login applies to the rejected account', () => {
    // Arrange / Act
    const actual = input({ remote: 'rejected', loginApplies: false });

    // Assert — the harness reads an environment variable and never consults its own credential store,
    // so a sign-in would open a browser, write a store nobody reads, and change nothing.
    should(actual).deepEqual({
      verdict: 'needs_credentials',
      reason: 'static_credential_rejected',
      evidence: 'anthropic_usage',
      conclusive: true,
    });
  });

  it('lets a positively dead local credential outrank a remote acceptance', () => {
    // Arrange — the remote read was made against the credential GROUP's representative home. This
    // sibling's own copy is gone, and it does not become healthy because the representative answered.
    const actual = input({ remote: 'accepted', local: { state: 'missing' } });

    // Assert
    should(actual).deepEqual({
      verdict: 'needs_relogin',
      reason: 'oauth_credential_missing',
      evidence: 'local_credential',
      conclusive: true,
    });
  });

  it('distinguishes an expired access token from a home with no credential at all', () => {
    // Arrange / Act — `classifyTokens` reports `missing` WITH an expiry when access expired and there
    // is no refresh token, and without one when there was never anything there.
    const expired = input({ local: { state: 'missing', expiresAt: NOW - 1 } });

    // Assert — two reasons, because they send a reader to two different places.
    should(expired.reason).equal('oauth_access_expired');
    should(input({ local: { state: 'missing' } }).reason).equal('oauth_credential_missing');
  });

  it('reports a dead static credential as needing a credential rather than a login', () => {
    should(input({ local: { state: 'missing' }, loginApplies: false })).deepEqual({
      verdict: 'needs_credentials',
      reason: 'static_credential_missing',
      evidence: 'local_credential',
      conclusive: true,
    });
  });

  it('never condemns an unreadable credential, and prefers that reason over the harness one', () => {
    // Arrange / Act — a Codex account whose credential could not be READ is a more specific fact than
    // "Codex cannot be proved", so the read failure wins.
    const actual = input({ kind: 'codex', local: { state: 'unreadable' } });

    // Assert
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'credential_unreadable',
      evidence: 'local_credential',
      conclusive: false,
    });
  });

  it('treats a probe that found no readable token as unreadable rather than rejected', () => {
    // Nothing was asked, so nothing was refused.
    should(input({ remote: 'absent' }).reason).equal('credential_unreadable');
  });

  it('publishes an honest unproven verdict for Codex', () => {
    // Arrange / Act — its usage endpoint answers 200 for stale tokens, so no free signal can create
    // healthy, and inventing one would be worse than saying so.
    const actual = input({ kind: 'codex', local: { state: 'valid', expiresAt: NOW + 1_000 } });

    // Assert
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'codex_liveness_unproven',
      evidence: 'none',
      conclusive: false,
    });
  });

  /**
   * NO REMOTE SIGNAL MAY GIVE CODEX A VERDICT — enforced here rather than left to the probe.
   *
   * Today `AnthropicUsageProbe` declines Codex and supplies no signal, so none of these inputs occurs
   * in production. That is the probe's RESTRAINT, not a rule, and the seam is public: a later Codex
   * usage probe, model-list read or cached `getAuthStatus` could set one. Its usage endpoint answers
   * `200` for tokens that are already STALE, so a signal-derived `healthy` would be exactly the lie
   * this feature promises never to tell.
   *
   * These cases are therefore deliberately UNREACHABLE TODAY and asserted anyway. That is the point:
   * they make the rule structural, so the next person to add a Codex probe cannot break it quietly.
   */
  it('refuses to let ANY remote signal produce a Codex verdict', () => {
    // Arrange — every signal an Anthropic-shaped probe can emit, against a Codex account.
    const signals: readonly FleetCredentialSignal[] = [
      'accepted',
      'scope_unavailable',
      'rejected',
      'timeout',
      'inconclusive',
    ];

    // Act / Assert — every one is unproven, and in particular NONE is healthy and none is a re-login.
    for (const remote of signals) {
      const actual = input({ kind: 'codex', remote, local: { state: 'valid', expiresAt: NOW + 1_000 } });
      should(actual).deepEqual(
        { verdict: 'unknown', reason: 'codex_liveness_unproven', evidence: 'none', conclusive: false },
        `a Codex account must not take a verdict from a ${remote} signal`,
      );
    }
  });

  it('still lets a positively DEAD local Codex credential condemn itself', () => {
    // Arrange / Act — the suppression is about the PROVIDER's claims, not about this home's own facts.
    // An absent credential is a fact about the home, so it survives and stays actionable.
    const actual = input({ kind: 'codex', remote: 'accepted', local: { state: 'missing' } });

    // Assert
    should(actual.verdict).equal('needs_relogin');
    should(actual.reason).equal('oauth_credential_missing');
  });

  it('still prefers the more specific unreadable reason for a Codex home', () => {
    // Arrange / Act — the signal is SUPPRESSED rather than short-circuited, so the rows below it stay
    // reachable. "The credential could not be read" is actionable; "Codex cannot be proved" is not,
    // and collapsing the first into the second would lose the useful half.
    const actual = input({ kind: 'codex', remote: 'accepted', local: { state: 'unreadable' } });

    // Assert
    should(actual.reason).equal('credential_unreadable');
  });

  it('keeps a timeout and an unreachable provider as separate inconclusive reasons', () => {
    should(input({ remote: 'timeout' }).reason).equal('check_timeout');
    should(input({ remote: 'inconclusive' }).reason).equal('provider_unavailable');
    // Neither is ever a rejection: a request that did not finish proves nothing about a credential.
    should([input({ remote: 'timeout' }).verdict, input({ remote: 'inconclusive' }).verdict]).deepEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('keeps a control-plane 401 inconclusive when it cannot distinguish the login from this client', () => {
    // Arrange / Act
    const actual = input({ remote: 'rejection_unconfirmed' as FleetCredentialSignal });

    // Assert — this result must never tell a person to sign in again. The response fingerprint is
    // retained separately so a later discriminator can explain which side was actually refused.
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'oauth_rejection_unconfirmed',
      evidence: 'anthropic_usage',
      conclusive: false,
    });
  });

  it('calls an expired-but-renewable credential unproven rather than signed out', () => {
    should(input({ local: { state: 'refreshable', expiresAt: NOW - 1 } })).deepEqual({
      verdict: 'unknown',
      reason: 'oauth_refreshable',
      evidence: 'local_credential',
      conclusive: false,
    });
  });

  it('lets an expired-but-refreshable local credential outrank a remote rejection', () => {
    // Arrange — a sync copies an already-expired access token (refresh token still present) onto a
    // sibling, and the remote probe sends that same expired token and is correctly told 401. That is a
    // fact about the STALE token the probe happened to try, not about whether this home can still sign
    // itself back in via its own refresh token. A positively dead local credential already outranks a
    // remote answer (see the `missing` case above); a refreshable one is not yet given the same rank.
    const actual = input({ remote: 'rejected', local: { state: 'refreshable', expiresAt: NOW - 1 } });

    // Assert — DESIRED: unproven, not condemned. Today this instead returns
    // needs_relogin/oauth_token_rejected, because the remote branch is checked before the local
    // `refreshable` branch runs, so this case is RED until that ordering changes.
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'oauth_refreshable',
      evidence: 'local_credential',
      conclusive: false,
    });
  });

  it('does not call a locally valid credential healthy', () => {
    // Arrange / Act — a current access token can have been revoked a minute ago, so a local reading is
    // structural evidence and never provider acceptance.
    const actual = input({ local: { state: 'valid', expiresAt: NOW + 60_000 } });

    // Assert
    should(actual).deepEqual({
      verdict: 'unknown',
      reason: 'provider_not_asked',
      evidence: 'local_credential',
      conclusive: false,
    });
  });

  it('reports never checked when there is neither a local reading nor a remote one', () => {
    should(input()).deepEqual({
      verdict: 'unknown',
      reason: 'never_checked',
      evidence: 'none',
      conclusive: false,
    });
  });
});

describe('observeAccountHealth', () => {
  it('joins the usage snapshot to local readings and sorts by account id', () => {
    // Arrange
    const declaredTwo = config({
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          routes: { default: { id: ID_ONE, wrapper: 'a', home: 'a', defaultModel: 'm', models: ['m'] } },
        },
        {
          name: 'sol',
          kind: 'claude',
          routes: { default: { id: ID_TWO, wrapper: 'b', home: 'b', defaultModel: 'm', models: ['m'] } },
        },
      ],
    });

    // Act
    const actual = observeAccountHealth({
      manifest: manifest([account(ID_TWO), account(ID_ONE)]),
      config: declaredTwo,
      usage: usage([
        { id: ID_ONE, signal: 'accepted' },
        { id: ID_TWO, signal: 'rejected' },
      ]),
      local: new Map<string, LocalCredentialReading>(),
      at: NOW,
    });

    // Assert
    should(actual.map(row => [row.accountId, row.verdict])).deepEqual([
      [ID_ONE, 'healthy'],
      [ID_TWO, 'needs_relogin'],
    ]);
    should(actual.every(row => row.at === NOW)).be.true();
  });

  it('reads login applicability from the declaration, so an env credential is never sent to a login', () => {
    // Arrange — the wrapper exports ANTHROPIC_API_KEY, so the harness never reads its own store.
    // Act
    const actual = observeAccountHealth({
      manifest: manifest([account(ID_ONE)]),
      config: declared({ env: { ANTHROPIC_API_KEY: 'literal-value' } }),
      usage: usage([{ id: ID_ONE, signal: 'rejected' }]),
      local: new Map(),
      at: NOW,
    });

    // Assert
    should(actual[0]?.verdict).equal('needs_credentials');
    should(actual[0]?.reason).equal('static_credential_rejected');
  });

  it('fails closed to offering a login for an account the configuration no longer declares', () => {
    // Arrange — a manifest outlives its configuration. Refusing to offer a login would leave a reader
    // with no action at all on the account most likely to be genuinely signed out.
    // Act
    const actual = observeAccountHealth({
      manifest: manifest([account('stranger')]),
      config: declared(),
      usage: usage([{ id: 'stranger', signal: 'rejected' }]),
      local: new Map(),
      at: NOW,
    });

    // Assert
    should(actual[0]?.verdict).equal('needs_relogin');
  });

  it('carries the local fingerprint through so a change guard can compare it', () => {
    // Arrange / Act
    const actual = observeAccountHealth({
      manifest: manifest([account(ID_ONE)]),
      config: declared(),
      usage: usage([{ id: ID_ONE, signal: 'accepted' }]),
      local: new Map<string, LocalCredentialReading>([
        [ID_ONE, { state: 'valid', fingerprint: 'abc', expiresAt: NOW + 1 }],
      ]),
      at: NOW,
    });

    // Assert
    should(actual[0]?.fingerprint).equal('abc');
  });

  it('omits the fingerprint when the read found no material to digest', () => {
    // Arrange / Act — "there is nothing here" must not compare equal to "there is something here".
    const actual = observeAccountHealth({
      manifest: manifest([account(ID_ONE)]),
      config: declared(),
      usage: usage([{ id: ID_ONE }]),
      local: new Map<string, LocalCredentialReading>([[ID_ONE, { state: 'unreadable' }]]),
      at: NOW,
    });

    // Assert
    should(actual[0]).not.have.property('fingerprint');
  });

  it('carries the provider response fingerprint into the health observation', () => {
    // Arrange
    const responseFingerprint = {
      status: 401,
      contentType: 'application/json',
      headerNames: ['content-type'],
      bodyLength: 42,
      bodySha256: 'b'.repeat(64),
      json: { type: 'object', fields: [{ path: 'error.type', type: 'string' }] },
    };

    // Act
    const actual = observeAccountHealth({
      manifest: manifest([account(ID_ONE)]),
      config: declared(),
      usage: usage([
        {
          id: ID_ONE,
          signal: 'rejection_unconfirmed' as FleetCredentialSignal,
          responseFingerprint,
        },
      ]),
      local: new Map([[ID_ONE, { state: 'valid' as const, expiresAt: NOW + 60_000 }]]),
      at: NOW,
    });

    // Assert
    should((actual[0] as unknown as { responseFingerprint?: unknown }).responseFingerprint).deepEqual(
      responseFingerprint,
    );
  });
});

describe('readLocalCredentials', () => {
  it('classifies every account and never lets a throw become a hard negative', async () => {
    // Arrange — `unreadable` is unknown; `missing` condemns a login. A keychain that timed out has
    // told us nothing about whether somebody is signed in.
    const classifier: FleetCredentialClassifier = {
      classify: async current => {
        if (current.id === 'broken') throw new Error('the keychain timed out');
        return { state: 'valid', fingerprint: 'f', expiresAt: NOW + 1 };
      },
    };

    // Act
    const actual = await readLocalCredentials(manifest([account('broken'), account('fine')]), classifier);

    // Assert
    should(actual.get('broken')).deepEqual({ state: 'unreadable' });
    should(actual.get('fine')?.state).equal('valid');
  });
});

describe('healthSnapshotFromObservations', () => {
  it('dates a conclusive verdict and leaves an inconclusive one undated', () => {
    // Arrange
    const observations = [
      {
        accountId: 'a',
        kind: 'claude',
        at: NOW,
        verdict: 'healthy' as const,
        reason: 'provider_accepted' as const,
        evidence: 'anthropic_usage' as const,
        conclusive: true,
        responseFingerprint: {
          status: 200,
          contentType: 'application/json' as const,
          headerNames: ['content-type' as const],
          bodyLength: 2,
          bodySha256: 'c'.repeat(64),
          json: { type: 'object' as const, fields: [] },
        },
      },
      {
        accountId: 'b',
        kind: 'codex',
        at: NOW,
        verdict: 'unknown' as const,
        reason: 'codex_liveness_unproven' as const,
        evidence: 'none' as const,
        conclusive: false,
      },
    ];

    // Act
    const actual = healthSnapshotFromObservations(observations, NOW);

    // Assert — `verdictAt` is when a claim was established, so an inconclusive row has none while
    // still recording that a check ran.
    should(actual.accounts[0]).deepEqual({
      accountId: 'a',
      kind: 'claude',
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW,
      verdictAt: NOW,
      lastCheckInconclusive: false,
      responseFingerprint: {
        status: 200,
        contentType: 'application/json',
        headerNames: ['content-type'],
        bodyLength: 2,
        bodySha256: 'c'.repeat(64),
        json: { type: 'object', fields: [] },
      },
    });
    should(actual.accounts[1]?.verdictAt).be.null();
    should(actual.accounts[1]?.lastCheckInconclusive).be.true();
  });
});

describe('buildFleetHealthCollector', () => {
  const classifier = (reading: LocalCredentialReading): FleetCredentialClassifier => ({
    classify: async () => reading,
  });

  it('collects the free usage read once and publishes the verdicts it establishes', async () => {
    // Arrange
    let collections = 0;
    const collector = buildFleetHealthCollector(
      declared(),
      {
        collect: async () => {
          collections += 1;
          return usage([{ id: ID_ONE, signal: 'scope_unavailable' }]);
        },
      },
      classifier({ state: 'valid', fingerprint: 'f', expiresAt: NOW + 1 }),
      { now: () => NOW },
    );

    // Act
    const actual = await collector.collect(manifest([account(ID_ONE)]));

    // Assert — ONE collection. A health collector running its own second pass would double the
    // provider calls to learn nothing.
    should(collections).equal(1);
    should(actual.at).equal(NOW);
    should(actual.accounts[0]?.verdict).equal('healthy');
    should(actual.accounts[0]?.reason).equal('usage_scope_unavailable');
    should(actual.accounts[0]?.lastCheckedAt).equal(NOW);
  });

  it('refuses to publish a snapshot dated by a broken clock', async () => {
    // Arrange
    const collector = buildFleetHealthCollector(
      declared(),
      { collect: async () => usage([{ id: ID_ONE, signal: 'accepted' }]) },
      classifier({ state: 'valid' }),
      { now: () => Number.NaN },
    );

    // Act / Assert — a snapshot stamped with a nonsense instant is worse than no snapshot: every
    // relative label and every staleness decision downstream reads from it.
    await should(collector.collect(manifest([account(ID_ONE)]))).be.rejectedWith(
      /the fleet clock did not return a valid instant/u,
    );
  });
});

describe('FLEET_HEALTH_FRESH_MS', () => {
  it('is comfortably longer than the free usage pass it rides', () => {
    // The pass runs on `usage.interval`, whose default is 60 seconds. A conclusion is therefore
    // normally re-proved many times before it could expire, and a fleet whose provider is unreachable
    // degrades to unknown rather than showing an hour-old verdict.
    should(FLEET_HEALTH_FRESH_MS).equal(15 * 60 * 1_000);
    should(FLEET_HEALTH_FRESH_MS).be.above(config().usage.interval * 1_000 * 10);
  });
});
