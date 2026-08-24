import { describe, expect, it } from 'bun:test';

import {
  absoluteInstantLabel,
  accountHealthOffersSignIn,
  accountHealthView,
  relativeInstantLabel,
  UNREAD_ACCOUNT_HEALTH,
} from '../../src/lib/account-health-view.ts';
import type { PickerAccountHealth, PickerHealthReason } from '../../src/lib/account-picker-catalog.ts';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const health = (overrides: Partial<PickerAccountHealth> = {}): PickerAccountHealth => ({
  accountId: 'acct',
  kind: 'claude',
  verdict: 'healthy',
  reason: 'provider_accepted',
  evidence: 'anthropic_usage',
  lastCheckedAt: NOW - 240_000,
  verdictAt: NOW - 240_000,
  lastCheckInconclusive: false,
  ...overrides,
});

describe('relativeInstantLabel', () => {
  it('uses whole units, coarsest that fits', () => {
    expect(relativeInstantLabel(NOW - 5_000, NOW)).toBe('just now');
    expect(relativeInstantLabel(NOW - 240_000, NOW)).toBe('4m ago');
    expect(relativeInstantLabel(NOW - 3_600_000, NOW)).toBe('1h ago');
    expect(relativeInstantLabel(NOW - 172_800_000, NOW)).toBe('2d ago');
  });

  it('never renders a future instant as negative', () => {
    // A daemon clock a little ahead of the browser is ordinary, and "-3m ago" is not a time.
    expect(relativeInstantLabel(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('absoluteInstantLabel', () => {
  it('is the exact UTC instant, for the accessible name rather than the visible label', () => {
    // The visible label is relative and ticks; the machine-readable one must be unambiguous.
    expect(absoluteInstantLabel(NOW)).toBe('2026-08-24T12:00:00.000Z');
  });
});

describe('accountHealthView', () => {
  it('prints the verdict, when it was checked, and why', () => {
    // Act
    const actual = accountHealthView(health(), NOW);

    // Assert — the time is part of the verdict, not decoration: "Healthy" with no instant is a claim
    // with no expiry, and the host's evidence has a fifteen-minute horizon.
    expect(actual).toMatchObject({
      label: 'Healthy',
      checked: 'Checked 4m ago',
      detail: 'The provider accepted this account’s credential.',
      tone: 'ok',
      offersSignIn: false,
    });
    expect(actual.secondary).toBeUndefined();
  });

  it('calls a 403 HEALTHY and says the QUOTA is what is unknown', () => {
    // Arrange / Act — the rule the whole feature turns on. Reading this as a rejection sends somebody
    // to re-login forever on an account that works perfectly.
    const actual = accountHealthView(health({ reason: 'usage_scope_unavailable' }), NOW);

    // Assert
    expect(actual.label).toBe('Healthy');
    expect(actual.tone).toBe('ok');
    expect(actual.detail).toContain('quota is not measurable');
    expect(actual.offersSignIn).toBeFalse();
  });

  it('offers a sign-in for a rejected OAuth credential', () => {
    // Act
    const actual = accountHealthView(health({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' }), NOW);

    // Assert
    expect(actual).toMatchObject({ label: 'Needs re-login', tone: 'bad', offersSignIn: true });
  });

  it('never offers a sign-in for an account no login can fix', () => {
    // Arrange / Act — the harness reads an environment variable and never consults its own credential
    // store, so a sign-in would open a browser, write a store nobody reads, and change nothing.
    const actual = accountHealthView(
      health({ verdict: 'needs_credentials', reason: 'static_credential_rejected' }),
      NOW,
    );

    // Assert
    expect(actual.label).toBe('Needs credential');
    expect(actual.tone).toBe('bad');
    expect(actual.offersSignIn).toBeFalse();
    expect(accountHealthOffersSignIn(health({ verdict: 'needs_credentials' }))).toBeFalse();
  });

  it('says NEVER CHECKED rather than inventing an instant', () => {
    // Act
    const actual = accountHealthView(
      health({ verdict: 'unknown', reason: 'never_checked', lastCheckedAt: null, verdictAt: null }),
      NOW,
    );

    // Assert — a fabricated "now" would be indistinguishable from a check that just succeeded.
    expect(actual).toMatchObject({ label: 'Unknown', checked: 'Never checked', tone: 'warn' });
  });

  it('dates a live conclusion from the EVIDENCE when the newest check failed', () => {
    // Arrange — a fresh healthy verdict, then a provider outage one minute ago.
    const actual = accountHealthView(
      health({ lastCheckedAt: NOW - 60_000, verdictAt: NOW - 480_000, lastCheckInconclusive: true }),
      NOW,
    );

    // Assert — "Confirmed" rather than "Checked", because the claim was last TRUE eight minutes ago
    // even though a request ran one minute ago. And the failed attempt is published rather than
    // hidden: a fleet that reads healthy while every provider call fails is the shape this prevents.
    expect(actual.checked).toBe('Confirmed 8m ago');
    expect(actual.secondary).toBe('The check 1m ago was inconclusive.');
  });

  it('does not claim an inconclusive secondary when there is no conclusion behind it', () => {
    // Arrange / Act — with no standing verdict the row already SAYS it could not be told, so a second
    // sentence saying the same thing is noise.
    const actual = accountHealthView(
      health({ verdict: 'unknown', reason: 'check_timeout', verdictAt: null, lastCheckInconclusive: false }),
      NOW,
    );

    // Assert
    expect(actual.checked).toBe('Checked 4m ago');
    expect(actual.secondary).toBeUndefined();
    expect(actual.detail).toBe('The last check timed out.');
  });

  it('tells a reader what a stale verdict WAS', () => {
    // Act
    const actual = accountHealthView(
      health({ verdict: 'unknown', reason: 'stale', staleVerdict: 'healthy', lastCheckedAt: NOW - 1_320_000 }),
      NOW,
    );

    // Assert — a bare Unknown here reads exactly like an account nobody ever checked.
    expect(actual.label).toBe('Unknown');
    expect(actual.detail).toBe('The last result is too old to trust. It last read healthy.');
    expect(actual.checked).toBe('Checked 22m ago');
  });

  it('publishes Codex as honestly unproven rather than as a fault', () => {
    // Act
    const actual = accountHealthView(
      health({ kind: 'codex', verdict: 'unknown', reason: 'codex_liveness_unproven', evidence: 'none' }),
      NOW,
    );

    // Assert — its usage endpoint answers 200 for stale tokens, so no free signal can create healthy.
    // This is the correct published answer, not a gap.
    expect(actual.detail).toContain('no free way to prove a sign-in');
    expect(actual.offersSignIn).toBeFalse();
  });

  it('has words for every reason the daemon can publish', () => {
    // Arrange — the copy table is exhaustive over the enum. A reason with no sentence would render as
    // `undefined` on screen, and "Unknown" with nothing after it is the state this feature exists to
    // stop showing people.
    const reasons: readonly PickerHealthReason[] = [
      'provider_accepted',
      'usage_scope_unavailable',
      'oauth_credential_missing',
      'oauth_access_expired',
      'oauth_token_rejected',
      'static_credential_missing',
      'static_credential_rejected',
      'never_checked',
      'credential_unreadable',
      'oauth_refreshable',
      'codex_liveness_unproven',
      'check_timeout',
      'provider_unavailable',
      'provider_not_asked',
      'credential_changed_during_check',
      'account_unavailable',
      'stale',
    ];

    // Act / Assert
    for (const reason of reasons) {
      const view = accountHealthView(health({ reason }), NOW);
      expect(view.detail.length).toBeGreaterThan(0);
      expect(view.detail).not.toContain('undefined');
    }
  });

  it('separates an expired-but-renewable credential from a signed-out one', () => {
    // Arrange / Act
    const renewable = accountHealthView(health({ verdict: 'unknown', reason: 'oauth_refreshable' }), NOW);
    const dead = accountHealthView(health({ verdict: 'needs_relogin', reason: 'oauth_access_expired' }), NOW);

    // Assert — one needs nothing from a person and the other needs a browser.
    expect(renewable.detail).toContain('not signed out');
    expect(renewable.offersSignIn).toBeFalse();
    expect(dead.offersSignIn).toBeTrue();
  });
});

describe('UNREAD_ACCOUNT_HEALTH', () => {
  it('is the quietest of the four tones, because it is an absence rather than a warning', () => {
    expect(UNREAD_ACCOUNT_HEALTH).toMatchObject({
      label: 'Unknown',
      checked: 'Never checked',
      tone: 'muted',
      offersSignIn: false,
    });
  });

  it('is frozen, so one row cannot mutate the fallback every other row reads', () => {
    expect(Object.isFrozen(UNREAD_ACCOUNT_HEALTH)).toBeTrue();
  });
});
