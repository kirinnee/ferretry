/**
 * The Accounts page's projection, and the sentences it owns.
 *
 * Pure, so every sentence a person reads is pinned here rather than asserted through a rendered tree.
 * Three things this suite exists to stop:
 *
 * 1. **A third set of words.** The verdict, the credential state and the usage line come from
 *    `account-health-view.ts` and `harness-login-model.ts`. The assertions compare against those
 *    modules' own output where that is the point, so a copy edit in one place cannot leave this page
 *    describing an account differently from the picker.
 * 2. **A control that cannot succeed.** An account whose credential is not a login, and an account the
 *    fleet publishes as unavailable, are two different nothings and neither is a bare greyed button.
 * 3. **The two sharing sentences going false.** They are about SUBSTITUTION, and the difference between
 *    the harnesses is the whole reason the page says anything at all.
 */

import { describe, expect, it } from 'bun:test';

import { accountSignInOffer, accountsRoster, HARNESS_SHARING } from '../../../../src/features/fleet/accounts-model.ts';
import { credentialStateCopy, usageSummary } from '../../../../src/features/fleet/harness-login-model.ts';
import { accountHealthView, UNREAD_ACCOUNT_HEALTH } from '../../../../src/lib/account-health-view.ts';
import {
  CLAUDE_ACCOUNT_ID,
  CLAUDE_SIBLING_ID,
  claudeIdentity,
  CODEX_ACCOUNT_ID,
  codexIdentity,
  healthMap,
  healthRow,
  keyedAccount,
  loginAccount,
  NOW,
  readiness,
  usageRow,
} from './harness-login-support.ts';

const rowsOf = (view: ReturnType<typeof accountsRoster>) => view.groups.flatMap(group => group.rows);

const rowFor = (view: ReturnType<typeof accountsRoster>, accountId: string) => {
  const row = rowsOf(view).find(candidate => candidate.accountId === accountId);
  if (row === undefined) throw new Error(`no row for ${accountId}`);
  return row;
};

describe('accountsRoster', () => {
  it('lists one row per ACCOUNT, flattened out of the identity tree', () => {
    const view = accountsRoster(readiness([claudeIdentity()]), new Map(), undefined, NOW);

    expect(rowsOf(view).map(row => row.accountId)).toEqual([CLAUDE_ACCOUNT_ID, CLAUDE_SIBLING_ID]);
    expect(view.total).toBe(2);
  });

  it('groups by harness, Claude first, and offers no group for a harness with no account', () => {
    const claudeOnly = accountsRoster(readiness([claudeIdentity()]), new Map(), undefined, NOW);
    const both = accountsRoster(readiness([codexIdentity(), claudeIdentity()]), new Map(), undefined, NOW);

    expect(claudeOnly.groups.map(group => group.kind)).toEqual(['claude']);
    // Fixed order regardless of the order the daemon listed the identities in: a roster that
    // reorders itself between reads is unreadable.
    expect(both.groups.map(group => group.kind)).toEqual(['claude', 'codex']);
  });

  it('reads its verdict and its instant from the shared health module, never from its own words', () => {
    const health = healthRow({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' });
    const view = accountsRoster(readiness([claudeIdentity()]), healthMap([health]), undefined, NOW);

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).health).toEqual(accountHealthView(health, NOW));
    expect(rowFor(view, CLAUDE_ACCOUNT_ID).checkedAt).toBe(health.lastCheckedAt);
  });

  it('treats an account with no published health row as UNREAD, not as unknown', () => {
    const view = accountsRoster(readiness([claudeIdentity()]), new Map(), undefined, NOW);

    // Absence of evidence is not evidence: `UNREAD_ACCOUNT_HEALTH` has its own sentence, and an
    // `unknown` row is somebody who looked and could not conclude.
    expect(rowFor(view, CLAUDE_ACCOUNT_ID).health).toEqual(UNREAD_ACCOUNT_HEALTH);
    expect(rowFor(view, CLAUDE_ACCOUNT_ID).checkedAt).toBeNull();
  });

  it('keeps a 403 HEALTHY, with the quota unknown rather than the account broken', () => {
    const health = healthRow({ verdict: 'healthy', reason: 'usage_scope_unavailable' });
    const view = accountsRoster(readiness([claudeIdentity()]), healthMap([health]), undefined, NOW);

    const row = rowFor(view, CLAUDE_ACCOUNT_ID);
    expect(row.health.label).toBe('Healthy');
    expect(row.health.tone).toBe('ok');
    // And the reason is NOT dropped as implied: "accepted, but quota is not measurable" carries a
    // second fact the headline does not.
    expect(row.health.detailIsImplied).toBe(false);
  });

  it('reports Codex’s honest unknown as unknown, with the reason it is not a verdict about Codex', () => {
    const health = healthRow({
      accountId: CODEX_ACCOUNT_ID,
      kind: 'codex',
      verdict: 'unknown',
      reason: 'codex_liveness_unproven',
      evidence: 'none',
    });
    const view = accountsRoster(readiness([codexIdentity()]), healthMap([health]), undefined, NOW);

    const row = rowFor(view, CODEX_ACCOUNT_ID);
    expect(row.health.label).toBe('Unknown');
    expect(row.health.detail).toContain('no free way to prove a sign-in');
  });

  it('joins the usage feed by WRAPPER name and states the direction', () => {
    const view = accountsRoster(
      readiness([claudeIdentity()]),
      new Map(),
      new Map([['claude-studio', usageRow({ usageBased: true, fiveHourPercent: 42, weeklyPercent: 9 })]]),
      NOW,
    );

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).usage).toContain('42% used');
    expect(rowFor(view, CLAUDE_ACCOUNT_ID).usageKind).toBe('windows');
    // The sibling wrapper has no row in the feed, so it is unknown — never a confident zero.
    expect(rowFor(view, CLAUDE_SIBLING_ID).usageKind).toBe('unknown');
  });

  it('spends the shared usage words rather than composing its own', () => {
    const row = usageRow({ usageBased: false });
    const view = accountsRoster(readiness([claudeIdentity()]), new Map(), new Map([['claude-studio', row]]), NOW);

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).usage).toBe(usageSummary({ kind: 'token-based' }));
  });

  it('carries the credential state from the shared module, expiry and all', () => {
    const credential = { state: 'valid', expiresAt: new Date(NOW + 3_600_000).toISOString() } as const;
    const view = accountsRoster(readiness([claudeIdentity([loginAccount({ credential })])]), new Map(), undefined, NOW);

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).credential).toBe(credentialStateCopy(credential, NOW));
  });

  it('says what one login covers, so a shared account is not mistaken for a per-account approval', () => {
    const shared = accountsRoster(readiness([claudeIdentity()]), new Map(), undefined, NOW);
    const alone = accountsRoster(readiness([claudeIdentity([loginAccount()])]), new Map(), undefined, NOW);

    expect(rowFor(shared, CLAUDE_ACCOUNT_ID).login).toMatchObject({
      identity: 'claude:studio',
      memberCount: 2,
      summary: 'This login covers 2 accounts, this one included.',
    });
    expect(rowFor(alone, CLAUDE_ACCOUNT_ID).login.summary).toBe('This login covers this account only.');
  });

  it('renders the fleet’s login verdict as a sentence, never as the word `sync`', () => {
    const view = accountsRoster(readiness([{ ...claudeIdentity(), verdict: 'sync' }]), new Map(), undefined, NOW);

    const state = rowFor(view, CLAUDE_ACCOUNT_ID).login.state;
    expect(state).toContain('has no credential of its own yet');
    expect(state).not.toContain('sync');
  });

  it('says nothing about a login that is complete', () => {
    const view = accountsRoster(readiness([{ ...claudeIdentity(), verdict: 'complete' }]), new Map(), undefined, NOW);

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).login.state).toBeUndefined();
  });

  it('keeps the daemon’s own reason beside the verdict rather than replacing either', () => {
    const withBoth = accountsRoster(
      readiness([{ ...claudeIdentity(), verdict: 'login', reason: 'the studio home has no credential.' }]),
      new Map(),
      undefined,
      NOW,
    );
    const reasonOnly = accountsRoster(
      readiness([{ ...claudeIdentity(), verdict: 'complete', reason: 'every member is signed in.' }]),
      new Map(),
      undefined,
      NOW,
    );

    expect(rowFor(withBoth, CLAUDE_ACCOUNT_ID).login.state).toBe(
      'This login needs somebody to sign in. the studio home has no credential.',
    );
    expect(rowFor(reasonOnly, CLAUDE_ACCOUNT_ID).login.state).toBe('every member is signed in.');
  });

  it('carries the mode and the availability the fleet published', () => {
    const view = accountsRoster(readiness([claudeIdentity()]), new Map(), undefined, NOW);

    expect(rowFor(view, CLAUDE_ACCOUNT_ID).mode).toBe('interactive');
    expect(rowFor(view, CLAUDE_SIBLING_ID).mode).toBe('auto');
    expect(rowFor(view, CLAUDE_ACCOUNT_ID).available).toBe(true);
  });

  it('reports an empty roster as empty rather than inventing a harness group', () => {
    const view = accountsRoster({ identities: [] }, new Map(), undefined, NOW);

    expect(view.groups).toEqual([]);
    expect(view.total).toBe(0);
  });
});

describe('accountSignInOffer', () => {
  it('offers `Sign in` to an account with no credential', () => {
    expect(accountSignInOffer(loginAccount({ credential: { state: 'missing' } }))).toEqual({
      kind: 'offered',
      label: 'Sign in',
    });
  });

  it('offers `Sign in again` to an account that already has one', () => {
    expect(accountSignInOffer(loginAccount({ credential: { state: 'valid' } }))).toEqual({
      kind: 'offered',
      label: 'Sign in again',
    });
  });

  it('offers nothing to a credential that is not a login, and says where it comes from', () => {
    const offer = accountSignInOffer(keyedAccount());

    expect(offer.kind).toBe('elsewhere');
    // The path is named, so "configured" and "broken" are distinguishable — which is the whole reason
    // the credential source is on the wire.
    expect(offer).toMatchObject({ badge: 'From a file' });
    expect(offer.kind === 'elsewhere' ? offer.detail : '').toContain('/etc/ferretry/secrets.sh');
  });

  it('prefers the harness’s OWN reason when the harness is what declined', () => {
    const offer = accountSignInOffer(
      loginAccount({
        login: {
          applies: false,
          because: 'harness-has-no-login',
          harnessReason: 'this build of claude offers no sign-in that can be driven from a browser',
        },
      }),
    );

    expect(offer.kind === 'elsewhere' ? offer.detail : '').toBe(
      'this build of claude offers no sign-in that can be driven from a browser',
    );
  });

  it('refuses an unavailable account its own way: a sign-in would work and change nothing', () => {
    const offer = accountSignInOffer(loginAccount({ available: false }));

    expect(offer.kind).toBe('unavailable');
    expect(offer.kind === 'unavailable' ? offer.detail : '').toContain('unable to run');
  });

  it('answers `elsewhere` before `unavailable` when both are true', () => {
    // Order matters: the credential is the fact a person acts on, and "this account cannot run" would
    // send somebody to fix availability for an account that also has no sign-in to run.
    expect(accountSignInOffer({ ...keyedAccount(), available: false }).kind).toBe('elsewhere');
  });
});

describe('HARNESS_SHARING', () => {
  it('says a Claude account can serve several members, and what can stand in for its sign-in', () => {
    expect(HARNESS_SHARING.claude.headline).toBe('A Claude account can serve several members.');
    expect(HARNESS_SHARING.claude.detail).toContain('Claude OAuth token can stand in');
    // "inference only" is the harness's own stated limit on such a token, and dropping it would sell a
    // full-scope login.
    expect(HARNESS_SHARING.claude.detail).toContain('inference only');
  });

  it('says a Codex account is signed in per member, and why nothing can stand in', () => {
    expect(HARNESS_SHARING.codex.headline).toBe('A Codex account is signed in per member.');
    expect(HARNESS_SHARING.codex.detail).toContain('API key is different auth');
    // The cost of the other route somebody would reach for. A shared `CODEX_HOME` is not a shared
    // credential — it is a shared agent.
    expect(HARNESS_SHARING.codex.detail).toContain('instructions, skills and logs');
  });

  it('never claims a sign-in reaches only one home: that is the login coverage’s job', () => {
    // Both harnesses clone a donor credential to the siblings of one identity, so a sentence here
    // saying "one home at a time" would be false. The per-row coverage line is where reach is stated.
    expect(HARNESS_SHARING.codex.detail).not.toContain('one home');
    expect(HARNESS_SHARING.claude.detail).toContain('One sign-in covers every member on the same login');
  });

  it('carries the sharing note onto the group a reader is looking at', () => {
    const view = accountsRoster(readiness([claudeIdentity(), codexIdentity()]), new Map(), undefined, NOW);

    expect(view.groups.map(group => group.sharing.headline)).toEqual([
      HARNESS_SHARING.claude.headline,
      HARNESS_SHARING.codex.headline,
    ]);
    expect(view.groups.map(group => group.label)).toEqual(['Claude', 'Codex']);
  });
});
