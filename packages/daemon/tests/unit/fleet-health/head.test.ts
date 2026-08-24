import { describe, it } from 'bun:test';
import type { AccountHealthObservation } from '@ferretry/fleet';
import { FLEET_HEALTH_FRESH_MS } from '@ferretry/fleet';
import should from 'should';
import {
  type AccountHealthHead,
  mergeAccountHealthHead,
  neverCheckedHead,
  projectAccountHealth,
} from '../../../src/lib/fleet-health/head.ts';

const NOW = 1_786_000_000_000;

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
    });
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
      observation({ verdict: 'unknown', reason: 'provider_unavailable', conclusive: false, fingerprint: 'aaa' }),
    );

    // Assert — the conclusion stands with its OWN older date, and the failure is published rather than
    // hidden. A fleet that reads healthy while every provider call fails is the shape this prevents.
    should(actual.verdict).equal('healthy');
    should(actual.verdictAt).equal(NOW - 60_000);
    should(actual.lastCheckedAt).equal(NOW);
    should(actual.lastCheckInconclusive).be.true();
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
