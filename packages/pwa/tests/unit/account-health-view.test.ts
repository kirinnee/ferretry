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
      'oauth_rejection_unconfirmed',
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
      // And a decision about that sentence, for every reason. `detailIsImplied` is annotated over the
      // same enum, so a reason added without one would be `undefined` here — silently falsy, which
      // means "print it", which is the safe direction but not a decision anybody made.
      expect(typeof view.detailIsImplied, reason).toBe('boolean');
    }
  });

  /**
   * WHAT A SURFACE WITH ONE LINE MAY LEAVE OUT — and, far more importantly, what it may not.
   *
   * The fleet roster spent three of every row's four lines on `Unknown · Never checked · Nothing has
   * checked this account yet.`, once per account, which is what made a list of accounts a wall. These
   * two flags are the offer that lets a surface stop doing that. Each assertion below is one thing
   * the offer must NOT cover.
   */
  it('is quiet only where nobody has looked, and never over a verdict', () => {
    // Nobody looked: three sentences saying the same nothing.
    expect(
      accountHealthView(
        health({ verdict: 'unknown', reason: 'never_checked', lastCheckedAt: null, verdictAt: null }),
        NOW,
      ).quiet,
    ).toBeTrue();
    // Somebody looked and could not conclude. SAME verdict, different row, and it must still speak.
    expect(accountHealthView(health({ verdict: 'unknown', reason: 'check_timeout' }), NOW).quiet).toBeFalse();
    expect(accountHealthView(health({ verdict: 'unknown', reason: 'codex_liveness_unproven' }), NOW).quiet).toBeFalse();
    // No verdict a person has to act on is ever silent.
    for (const verdict of ['healthy', 'needs_relogin', 'needs_credentials'] as const) {
      expect(accountHealthView(health({ verdict }), NOW).quiet, verdict).toBeFalse();
    }
  });

  it('implies only the reasons that restate their own headline', () => {
    // "The provider accepted this credential" IS `Healthy`, so a one-line surface may drop it.
    expect(accountHealthView(health(), NOW).detailIsImplied).toBeTrue();
    // THE PAIR THAT MUST SURVIVE. `Healthy` beside "quota is not measurable" is two facts, and a row
    // that dropped the second reads an unmeasurable account as a broken one.
    expect(accountHealthView(health({ reason: 'usage_scope_unavailable' }), NOW).detailIsImplied).toBeFalse();
    expect(
      accountHealthView(health({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' }), NOW).detailIsImplied,
    ).toBeFalse();
    // A stale row's detail says WHAT went stale, so it is never the reason's own sentence.
    expect(
      accountHealthView(health({ verdict: 'unknown', reason: 'stale', staleVerdict: 'healthy' }), NOW).detailIsImplied,
    ).toBeFalse();
  });

  it('separates an expired-but-renewable credential from a signed-out one', () => {
    // Arrange / Act
    const renewable = accountHealthView(health({ verdict: 'unknown', reason: 'oauth_refreshable' }), NOW);
    const dead = accountHealthView(health({ verdict: 'needs_relogin', reason: 'oauth_access_expired' }), NOW);

    // Assert — one needs nothing from a person and the other needs a browser. It LEADS with being
    // signed in, because that is the true and reassuring half: the previous wording, "Expired but
    // renewable. This is not signed out.", opened with a problem and then took it back.
    expect(renewable.detail).toBe('Signed in, but this copy needs refreshing.');
    expect(renewable.offersSignIn).toBeFalse();
    expect(dead.offersSignIn).toBeTrue();
  });

  it('offers no sign-in for a rejection it could not attribute, and says so in the detail', () => {
    // Arrange / Act — a `401` from that endpoint cannot tell a dead login from a client the provider
    // does not accept, so reading it as a rejected login sends somebody to re-authenticate a login
    // that is fine. That costs a browser approval and fixes nothing, which is the worst outcome here.
    const view = accountHealthView(health({ verdict: 'unknown', reason: 'oauth_rejection_unconfirmed' }), NOW);

    // Assert — the sentence states the limit AND rules out the wrong action, because a reader who
    // sees "refused" will otherwise supply that action themselves.
    expect(view.offersSignIn).toBeFalse();
    expect(view.detail).toContain('could not tell whether the provider rejected this login or this client');
    expect(view.detail).toContain('does not mean you need to sign in again');
    expect(view.detailIsImplied).toBeFalse();
  });
});

describe('UNREAD_ACCOUNT_HEALTH', () => {
  it('is the quietest of the four tones, because it is an absence rather than a warning', () => {
    expect(UNREAD_ACCOUNT_HEALTH).toMatchObject({
      label: 'Unknown',
      checked: 'Never checked',
      tone: 'muted',
      offersSignIn: false,
      // The same absence the computed view reports, so a surface that takes the offer treats "no row
      // published for this account" and "a row that says nobody has looked" identically.
      quiet: true,
      detailIsImplied: true,
    });
  });

  it('is frozen, so one row cannot mutate the fallback every other row reads', () => {
    expect(Object.isFrozen(UNREAD_ACCOUNT_HEALTH)).toBeTrue();
  });
});

/**
 * THE SEEDED-COPY DISCLOSURE, and the sentence the honesty constraint lives in.
 *
 * The Claude case asserts BOTH halves — that the conditional is present and that the flat claim is
 * absent — because asserting only the first passes over "if Claude rotates refresh tokens, renewing
 * this signs that install out": conditional in form and an assertion in substance.
 */
describe('the seed-provenance note', () => {
  const seeded = (
    provenance: Partial<NonNullable<PickerAccountHealth['seedProvenance']>> = {},
    row: Partial<PickerAccountHealth> = {},
  ) =>
    accountHealthView(
      health({
        seedProvenance: {
          state: 'seeded_copy',
          donorHome: '/home/me/.claude',
          seededAt: Date.UTC(2026, 7, 12, 9, 30),
          rotation: 'unproven',
          ...provenance,
        },
        ...row,
      }),
      NOW,
    ).seedProvenance;

  it('says nothing at all about an account with no record', () => {
    // Assert — absence of a record is NOT evidence of an own login. A home seeded before the daemon
    // learned to record this can never get a record, so those are exactly the accounts that must not
    // be cleared by silence being read as a verdict.
    expect(accountHealthView(health(), NOW).seedProvenance).toBeUndefined();
  });

  it('names the install and the day the copy was taken', () => {
    // Assert — the directory is the only thing a person can go and check, and the date is absolute
    // because a seed may be months old and "94d ago" is not something anybody can match to a memory.
    expect(seeded()?.headline).toBe(
      'Still the copy taken from this host’s own Claude install (/home/me/.claude) on 12 Aug 2026.',
    );
  });

  it('keeps the Claude consequence CONDITIONAL, because nothing proves Claude rotates', () => {
    // Assert — single-use rotation is established for Codex only. For Claude the evidence is that a
    // REPLACEMENT refresh token is stored, which is not the same claim as the old one being killed.
    const note = seeded();
    expect(note?.consequence).toBe(
      'If Claude rotates refresh tokens, renewing this — or running an agent on it — may sign that install out.',
    );
    // And the flat claim is NOT made. This half is what a copy-editing pass would delete.
    expect(note?.consequence).not.toContain('signs that install out');
    expect(note?.consequence).not.toContain('will sign');
  });

  it('says the Codex consequence flatly, because single-use rotation is established there', () => {
    // Assert
    const note = seeded({ donorHome: '/home/me/.codex', rotation: 'single_use' }, { kind: 'codex' });
    expect(note?.consequence).toBe(
      'Codex refresh tokens are single-use, so renewing this — or running an agent on it — signs that install out.',
    );
    expect(note?.consequence).not.toContain('If Codex rotates');
  });

  it('reads the rotation claim off the row rather than deriving it from the harness', () => {
    // Assert — the daemon owns that claim once, for this browser and for the terminal. A browser that
    // decided it from `kind` would be a second opinion, and the two would eventually disagree about
    // what may be asserted of somebody's login.
    expect(seeded({ rotation: 'single_use' })?.consequence).toContain('Claude refresh tokens are single-use');
  });

  it('hedges the whole sentence when the credential could not be read', () => {
    // Assert — fail-closed, and SAID to be fail-closed.
    const note = seeded({ state: 'undetermined' });
    expect(note?.headline).toContain('could not be read, so this cannot tell whether it is still the copy');
    expect(note?.headline).toContain('It is shown as if it were.');
    expect(note?.tone).toBe('warn');
  });

  it('drops the consequence for a home that has since rotated, and goes quiet', () => {
    // Assert — the risk has passed. A warning about a consequence that can no longer happen is noise
    // on the one row that should be quiet, and it is `muted` rather than `warn` for the same reason.
    const note = seeded({ state: 'own_login' });
    expect(note?.headline).toContain('Its own login.');
    expect(note?.headline).toContain('has been replaced since');
    expect(note?.consequence).toBeUndefined();
    expect(note?.tone).toBe('muted');
  });

  it('is never painted as a fault', () => {
    // Assert — a seeded copy is not a broken account, and painting it like one teaches a reader to
    // look past the colour on the rows where something really is wrong.
    for (const state of ['seeded_copy', 'own_login', 'undetermined'] as const) {
      const tone = seeded({ state })?.tone;
      expect(tone).toBeDefined();
      expect(['warn', 'muted']).toContain(tone ?? 'bad');
    }
  });

  it('prints the raw harness when the daemon named one this build does not know', () => {
    // Assert — `kind` is an open string on the wire so a third harness stays conformant. A closed
    // lookup would put `undefined` in the middle of a sentence about somebody's credential.
    expect(seeded({}, { kind: 'gemini' })?.headline).toContain('this host’s own gemini install');
  });
});
