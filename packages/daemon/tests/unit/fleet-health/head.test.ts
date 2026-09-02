import { describe, it } from 'bun:test';
import type { AccountHealthObservation } from '@ferretry/fleet';
import { FLEET_HEALTH_FRESH_MS } from '@ferretry/fleet';
import should from 'should';
import {
  type AccountHealthHead,
  AccountHealthHeadSchema,
  mergeAccountHealthHead,
  neverCheckedHead,
  projectAccountHealth,
} from '../../../src/lib/fleet-health/head.ts';

const NOW = 1_786_000_000_000;
const RESPONSE_FINGERPRINT = {
  status: 401,
  contentType: 'application/json',
  headerNames: ['content-type', 'request-id', 'server'],
  headers: { server: 'cloudflare' },
  bodyLength: 73,
  bodySha256: 'd'.repeat(64),
  json: {
    type: 'object' as const,
    fields: [{ path: 'error.type', type: 'string' as const }],
    errorType: 'authentication_error',
  },
};

const observation = (patch: Partial<AccountHealthObservation> = {}): AccountHealthObservation => ({
  accountId: 'acct',
  kind: 'claude',
  at: NOW,
  verdict: 'healthy',
  reason: 'provider_accepted',
  evidence: 'anthropic_usage',
  conclusive: true,
  ...patch,
});

const head = (patch: Partial<AccountHealthHead> = {}): AccountHealthHead => ({
  ...neverCheckedHead('acct', 'claude'),
  ...patch,
});

describe('neverCheckedHead', () => {
  it('invents no verdict and no timestamp', () => {
    // Assert — a fabricated "now" here is indistinguishable on the wire from a check that just ran,
    // and telling those apart is the whole point of the feature.
    should(neverCheckedHead('acct', 'claude')).deepEqual({
      accountId: 'acct',
      kind: 'claude',
      verdict: 'unknown',
      reason: 'never_checked',
      evidence: 'none',
      lastCheckedAt: null,
      verdictAt: null,
      lastCheckInconclusive: false,
      fingerprint: null,
      responseFingerprint: null,
      seedProvenance: null,
    });
  });
});

/**
 * The seeded-copy disclosure is not a conclusion, so neither of the head's two protection rules
 * applies to it: it is a statement about the credential that was just digested, and the newest
 * observation is therefore always the right answer.
 */
describe('the seed-provenance disclosure on a head', () => {
  const provenance = {
    state: 'seeded_copy' as const,
    donorHome: '/home/me/.claude',
    seededAt: NOW - 90_000,
    rotation: 'unproven' as const,
  };

  it('records the newest reading', () => {
    // Act / Assert
    should(mergeAccountHealthHead(undefined, observation({ seedProvenance: provenance })).seedProvenance).deepEqual(
      provenance,
    );
  });

  it('updates it even when the pass concluded nothing', () => {
    // Arrange — a standing conclusion the inconclusive arm preserves.
    const previous = head({ verdict: 'healthy', reason: 'provider_accepted', verdictAt: NOW - 60_000 });

    // Act
    const merged = mergeAccountHealthHead(
      previous,
      observation({ conclusive: false, verdict: 'unknown', reason: 'check_timeout', seedProvenance: provenance }),
    );

    // Assert — a provider read that failed says nothing about whether the LOCAL credential is still
    // the seeded copy, and the local digest was read either way.
    should(merged.verdict).equal('healthy');
    should(merged.seedProvenance).deepEqual(provenance);
  });

  it('updates it even when a remote rejection was discarded by the change guard', () => {
    // Arrange — the credential moved mid-check, so the verdict is thrown away. The provenance is
    // about the credential that is there NOW, which is exactly what was just digested.
    const previous = head({ fingerprint: 'old', verdictAt: NOW - 60_000 });

    // Act
    const merged = mergeAccountHealthHead(
      previous,
      observation({
        verdict: 'needs_relogin',
        reason: 'oauth_token_rejected',
        fingerprint: 'new',
        seedProvenance: { ...provenance, state: 'own_login' },
      }),
    );

    // Assert
    should(merged.reason).equal('credential_changed_during_check');
    should(merged.seedProvenance?.state).equal('own_login');
  });

  it('clears it when the newest pass recorded none', () => {
    // Arrange — the record was removed, or the account is no longer one this daemon has a record for.
    const previous = head({ seedProvenance: provenance });

    // Act / Assert — a home must stop being disclosed as a copy the moment nothing says it is one.
    should(mergeAccountHealthHead(previous, observation()).seedProvenance).be.null();
  });

  it('parses a stored document written before this field existed', () => {
    // Assert — one field with an obvious absent value, not a migration. Without the default, every
    // host would publish a whole fleet of never-checked accounts for a usage interval after upgrade.
    const stored = AccountHealthHeadSchema.parse({
      accountId: 'acct',
      kind: 'claude',
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW,
      verdictAt: NOW,
      lastCheckInconclusive: false,
      fingerprint: 'aaa',
      responseFingerprint: null,
    });
    should(stored.seedProvenance).be.null();
  });

  it('publishes it on a fresh row and on a stale one alike', () => {
    // Assert — staleness bounds a VERDICT. Where a credential came from does not go stale in the
    // same way, and a stale row is exactly where somebody is most likely to reach for Renew.
    should(projectAccountHealth(head({ seedProvenance: provenance, verdictAt: NOW }), NOW).seedProvenance).deepEqual(
      provenance,
    );
    const stale = projectAccountHealth(
      head({ seedProvenance: provenance, verdict: 'healthy', verdictAt: NOW - FLEET_HEALTH_FRESH_MS - 1 }),
      NOW,
    );
    should(stale.reason).equal('stale');
    should(stale.seedProvenance).deepEqual(provenance);
  });

  it('omits the field entirely when nothing was recorded', () => {
    // Assert — ABSENT on the wire, so a surface cannot mistake it for a reading. Absence of a record
    // is not evidence that an account owns its credential.
    should(projectAccountHealth(head(), NOW)).not.have.property('seedProvenance');
  });
});

describe('mergeAccountHealthHead', () => {
  it('commits a conclusive verdict onto a head that has never been checked', () => {
    // Act
    const actual = mergeAccountHealthHead(undefined, observation({ fingerprint: 'aaa' }));

    // Assert
    should(actual).deepEqual({
      accountId: 'acct',
      kind: 'claude',
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW,
      verdictAt: NOW,
      lastCheckInconclusive: false,
      fingerprint: 'aaa',
      responseFingerprint: null,
      seedProvenance: null,
    });
  });

  it('ages a standing conclusion rather than erasing it when a check is inconclusive', () => {
    // Arrange — a fresh healthy verdict, then a provider outage.
    const stored = head({
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - 60_000,
      verdictAt: NOW - 60_000,
      fingerprint: 'aaa',
    });

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({
        verdict: 'unknown',
        reason: 'provider_unavailable',
        conclusive: false,
        fingerprint: 'aaa',
        responseFingerprint: RESPONSE_FINGERPRINT,
      } as Partial<AccountHealthObservation>),
    );

    // Assert — the conclusion stands with its OWN older date, and the failure is published rather than
    // hidden. A fleet that reads healthy while every provider call fails is the shape this prevents.
    should(actual.verdict).equal('healthy');
    should(actual.verdictAt).equal(NOW - 60_000);
    should(actual.lastCheckedAt).equal(NOW);
    should(actual.lastCheckInconclusive).be.true();
    should((actual as unknown as { responseFingerprint?: unknown }).responseFingerprint).deepEqual(
      RESPONSE_FINGERPRINT,
    );
  });

  it('clears an old response fingerprint when the newest observation made no provider request', () => {
    // Arrange — response evidence belongs to the newest actual check, never to a prior check whose
    // status happens to remain the standing conclusion.
    const stored = head({ responseFingerprint: RESPONSE_FINGERPRINT } as Partial<AccountHealthHead>);

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({
        verdict: 'unknown',
        reason: 'oauth_refreshable',
        evidence: 'local_credential',
        conclusive: false,
      }),
    );

    // Assert
    should((actual as unknown as { responseFingerprint?: unknown }).responseFingerprint).be.null();
  });

  it('refuses to condemn a credential that was REPLACED while the remote check ran', () => {
    // Arrange — the exact dangerous sequence: a 401 was in flight, the person signed in again, and the
    // rejection came back about a credential that no longer exists. `bbb` is the new one.
    const stored = head({
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - 60_000,
      verdictAt: NOW - 60_000,
      fingerprint: 'aaa',
    });

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({
        verdict: 'needs_relogin',
        reason: 'oauth_token_rejected',
        evidence: 'anthropic_usage',
        fingerprint: 'bbb',
      }),
    );

    // Assert — it errs toward unknown, never toward condemned. Committing the rejection would send
    // somebody to do again the thing they had just done.
    should(actual.verdict).equal('unknown');
    should(actual.reason).equal('credential_changed_during_check');
    should(actual.verdictAt).be.null();
    should(actual.lastCheckedAt).equal(NOW);
    should(actual.fingerprint).equal('bbb');
  });

  it('commits a remote rejection when the credential did NOT change', () => {
    // Arrange
    const stored = head({
      verdict: 'healthy',
      verdictAt: NOW - 60_000,
      lastCheckedAt: NOW - 60_000,
      fingerprint: 'aaa',
    });

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({
        verdict: 'needs_relogin',
        reason: 'oauth_token_rejected',
        evidence: 'anthropic_usage',
        fingerprint: 'aaa',
      }),
    );

    // Assert — the guard must not swallow a real rejection, or nothing could ever be reported.
    should(actual.verdict).equal('needs_relogin');
    should(actual.verdictAt).equal(NOW);
  });

  it('commits a remote rejection on the FIRST observation, which has nothing to have changed from', () => {
    // Act
    const actual = mergeAccountHealthHead(
      undefined,
      observation({
        verdict: 'needs_relogin',
        reason: 'oauth_token_rejected',
        evidence: 'anthropic_usage',
        fingerprint: 'aaa',
      }),
    );

    // Assert
    should(actual.verdict).equal('needs_relogin');
  });

  it('never applies the change guard to a LOCAL negative, so a sign-OUT is reported', () => {
    // Arrange — signing out changes the digest exactly as signing in does. A local verdict was decided
    // from the very material just digested, so it cannot be about a credential since replaced.
    const stored = head({
      verdict: 'healthy',
      verdictAt: NOW - 60_000,
      lastCheckedAt: NOW - 60_000,
      fingerprint: 'aaa',
    });

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({
        verdict: 'needs_relogin',
        reason: 'oauth_credential_missing',
        evidence: 'local_credential',
        // No material left to digest, which is what a sign-out looks like.
      }),
    );

    // Assert
    should(actual.verdict).equal('needs_relogin');
    should(actual.reason).equal('oauth_credential_missing');
    should(actual.fingerprint).be.null();
  });

  it('does not treat an absent digest on either side as a change', () => {
    // Arrange — an unreadable credential has no digest. Comparing `null` to a value would make every
    // keychain failure look like a replacement and suppress verdicts forever.
    const stored = head({ verdict: 'unknown', fingerprint: null, lastCheckedAt: NOW - 1_000 });

    // Act
    const actual = mergeAccountHealthHead(
      stored,
      observation({ verdict: 'needs_relogin', reason: 'oauth_token_rejected', evidence: 'anthropic_usage' }),
    );

    // Assert
    should(actual.verdict).equal('needs_relogin');
  });

  it('adopts the inconclusive reason when there is NO conclusion to protect', () => {
    // Arrange — the first check on a fresh account times out. Preserving the head's `never_checked`
    // would leave a CHECKED account reading "nobody has looked", which is false and is exactly the
    // sentence this feature exists to stop showing people.
    // Act
    const actual = mergeAccountHealthHead(
      undefined,
      observation({ verdict: 'unknown', reason: 'check_timeout', evidence: 'anthropic_usage', conclusive: false }),
    );

    // Assert — and `lastCheckInconclusive` stays false, because the verdict already says it could not
    // be told; flagging it too would say the same thing twice on screen.
    should(actual.reason).equal('check_timeout');
    should(actual.lastCheckedAt).equal(NOW);
    should(actual.verdictAt).be.null();
    should(actual.lastCheckInconclusive).be.false();
  });

  it('carries a changed harness kind forward, since a head outlives one manifest', () => {
    should(
      mergeAccountHealthHead(head({ kind: 'claude' }), observation({ kind: 'codex', conclusive: false })).kind,
    ).equal('codex');
  });
});

describe('projectAccountHealth', () => {
  it('publishes the response fingerprint stored with the newest check', () => {
    // Arrange
    const stored = head({
      verdict: 'unknown',
      reason: 'provider_unavailable',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW,
      responseFingerprint: RESPONSE_FINGERPRINT,
    } as Partial<AccountHealthHead>);

    // Act
    const actual = projectAccountHealth(stored, NOW);

    // Assert
    should((actual as unknown as { responseFingerprint?: unknown }).responseFingerprint).deepEqual(
      RESPONSE_FINGERPRINT,
    );
  });

  it('publishes a fresh conclusion unchanged, with no stale marker', () => {
    // Arrange
    const stored = head({
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - 1_000,
      verdictAt: NOW - 1_000,
    });

    // Act
    const actual = projectAccountHealth(stored, NOW);

    // Assert
    should(actual).deepEqual({
      accountId: 'acct',
      kind: 'claude',
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - 1_000,
      verdictAt: NOW - 1_000,
      lastCheckInconclusive: false,
    });
  });

  it('publishes an aged conclusion as unknown while saying what it WAS', () => {
    // Arrange — one millisecond past the horizon.
    const stored = head({
      verdict: 'healthy',
      reason: 'provider_accepted',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - FLEET_HEALTH_FRESH_MS - 1,
      verdictAt: NOW - FLEET_HEALTH_FRESH_MS - 1,
    });

    // Act
    const actual = projectAccountHealth(stored, NOW);

    // Assert — a bare unknown here reads exactly like an account nobody ever checked, so the previous
    // reading travels with it.
    should(actual.verdict).equal('unknown');
    should(actual.reason).equal('stale');
    should(actual.staleVerdict).equal('healthy');
    should(actual.lastCheckedAt).equal(NOW - FLEET_HEALTH_FRESH_MS - 1);
  });

  it('expires a NEGATIVE conclusion too', () => {
    // Arrange — somebody who signs in again in a terminal must not stay condemned by a rejection this
    // daemon happened to observe first.
    const stored = head({
      verdict: 'needs_relogin',
      reason: 'oauth_token_rejected',
      evidence: 'anthropic_usage',
      lastCheckedAt: NOW - FLEET_HEALTH_FRESH_MS - 1,
      verdictAt: NOW - FLEET_HEALTH_FRESH_MS - 1,
    });

    // Act
    const actual = projectAccountHealth(stored, NOW);

    // Assert
    should(actual.verdict).equal('unknown');
    should(actual.staleVerdict).equal('needs_relogin');
  });

  it('keeps a conclusion exactly at the horizon', () => {
    // Arrange — the boundary is inclusive, so a verdict re-proved at the interval never flickers.
    const stored = head({
      verdict: 'healthy',
      reason: 'provider_accepted',
      lastCheckedAt: NOW - FLEET_HEALTH_FRESH_MS,
      verdictAt: NOW - FLEET_HEALTH_FRESH_MS,
    });

    // Act / Assert
    should(projectAccountHealth(stored, NOW).verdict).equal('healthy');
  });

  it('cannot make a never-checked head stale, because there is no conclusion to age', () => {
    // Act — `verdictAt` is null, so no amount of elapsed time produces `stale`.
    const actual = projectAccountHealth(neverCheckedHead('acct', 'claude'), NOW);

    // Assert
    should(actual.reason).equal('never_checked');
    should(actual.lastCheckedAt).be.null();
    should(actual).not.have.property('staleVerdict');
  });

  it('truncates a fractional instant rather than publishing one the schema refuses', () => {
    should(projectAccountHealth(head({ lastCheckedAt: NOW }), NOW + 0.7).lastCheckedAt).equal(NOW);
  });
});
