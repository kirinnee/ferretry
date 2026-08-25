import { describe, expect, it } from 'bun:test';

import {
  accountUsageReadout,
  credentialSourceCopy,
  credentialStateCopy,
  timeUntil,
  usageSummary,
  usageWindowLabel,
} from '../../../../src/features/fleet/harness-login-model.ts';
import { NOW, usageRow } from './harness-login-support.ts';

const LATER = new Date(NOW + 3_600_000).toISOString();

describe('credentialSourceCopy', () => {
  it('names the file and the variable when the credential comes from a token file', () => {
    const copy = credentialSourceCopy({
      source: 'token-file',
      variable: 'ANTHROPIC_API_KEY',
      path: '/etc/ferretry/secrets.sh',
    });

    expect(copy.label).toBe('From a file');
    expect(copy.detail).toContain('ANTHROPIC_API_KEY');
    expect(copy.detail).toContain('/etc/ferretry/secrets.sh');
    expect(copy.detail).toContain('no sign-in to run');
  });

  it('names the variable when the credential comes from the environment', () => {
    const copy = credentialSourceCopy({ source: 'environment', variable: 'OPENAI_API_KEY' });

    expect(copy.label).toBe('From the environment');
    expect(copy.detail).toContain('OPENAI_API_KEY');
  });

  it('says the configuration carries it when the value is configured', () => {
    const copy = credentialSourceCopy({ source: 'configured-value', variable: 'ANTHROPIC_API_KEY' });

    expect(copy.label).toBe('From the configuration');
    expect(copy.detail).toContain('the fleet configuration carries');
  });

  it('refuses to guess when nothing declares where the key comes from', () => {
    const copy = credentialSourceCopy({ source: 'undeclared' });

    expect(copy.label).toBe('Not declared');
    expect(copy.detail).toContain('nothing in this fleet');
    // It must not name a variable or a file: there is none, and naming one would send somebody to look
    // at something that does not exist.
    expect(copy.detail).not.toContain('ANTHROPIC');
    expect(copy.detail).not.toContain('/etc');
  });

  it('says the harness writes it when the credential does come from a sign-in', () => {
    expect(credentialSourceCopy({ source: 'interactive-login' }).label).toBe('From signing in');
  });

  it('names the secret store, and the secrets, when a profile authenticates this account', () => {
    const copy = credentialSourceCopy({ source: 'secret-store', variable: 'ANTHROPIC_API_KEY', secrets: ['WORK_KEY'] });

    expect(copy.label).toBe('From the secret store');
    expect(copy.detail).toContain('ANTHROPIC_API_KEY');
    expect(copy.detail).toContain('secret WORK_KEY');
    expect(copy.detail).toContain('no sign-in to run');
  });

  it('does not collapse the secret store into the environment, because they are two different places', () => {
    // Both sentences would be TRUE of this account — the daemon does put the value into the
    // environment the wrapper is launched with — but they send somebody to two different places and
    // only one of them is somewhere they can act: `fy secret set` on this host. So the store answer
    // must not read as the environment one, and it must name the secret rather than the variable
    // alone, which is the only thing that tells somebody WHAT to set.
    const store = credentialSourceCopy({
      source: 'secret-store',
      variable: 'ANTHROPIC_API_KEY',
      secrets: ['WORK_KEY'],
    });
    const environment = credentialSourceCopy({ source: 'environment', variable: 'ANTHROPIC_API_KEY' });

    expect(store.label).not.toBe(environment.label);
    expect(store.detail).not.toBe(environment.detail);
    expect(environment.detail).not.toContain('WORK_KEY');
  });

  it('says "secrets" when one variable is composed from more than one of them', () => {
    const copy = credentialSourceCopy({
      source: 'secret-store',
      variable: 'AUTH_HEADER',
      secrets: ['SCHEME', 'WORK_KEY'],
    });

    expect(copy.detail).toContain('secrets SCHEME, WORK_KEY');
  });

  it('names the secret and never a value, because no route in this product returns one', () => {
    // The names are the whole point of saying it and they are safe to render: a person who cannot see
    // which secret an account reaches for cannot fix one nobody has set. The sixty characters the
    // store holds under that name reach one child's environment, and this shape has nowhere to put one.
    const copy = credentialSourceCopy({ source: 'secret-store', variable: 'ANTHROPIC_API_KEY', secrets: ['WORK_KEY'] });

    expect(Object.keys(copy).toSorted()).toEqual(['detail', 'label']);
  });
});

describe('credentialStateCopy', () => {
  it('says how long a valid credential has left', () => {
    expect(credentialStateCopy({ state: 'valid', expiresAt: LATER }, NOW)).toBe('Signed in · expires in 1h');
  });

  it('says signed in when a valid credential carries no expiry', () => {
    expect(credentialStateCopy({ state: 'valid' }, NOW)).toBe('Signed in');
  });

  it('does not call a refreshable credential expired, because it renews itself', () => {
    const copy = credentialStateCopy({ state: 'refreshable', expiresAt: LATER }, NOW);

    expect(copy).toBe('Signed in · renews itself on next use, if the provider still accepts it');
    expect(copy).not.toContain('expired');
    // And it does not PROMISE the renewal: a rotation the provider refuses makes the harness zero its own
    // credential, so this state can legitimately become `missing` with nobody having touched the account.
    expect(copy).toContain('if the provider still accepts it');
  });

  it('says not signed in for a missing credential', () => {
    expect(credentialStateCopy({ state: 'missing' }, NOW)).toBe('Not signed in');
  });

  it('carries the daemon’s own reason for an unreadable credential', () => {
    expect(credentialStateCopy({ state: 'unreadable', reason: 'the keychain is locked' }, NOW)).toBe(
      'Could not be read — the keychain is locked',
    );
  });

  it('says nothing was read when the credential does not come from a sign-in', () => {
    const copy = credentialStateCopy({ state: 'not-read' }, NOW);

    expect(copy).toContain('Nothing was read');
    // Emphatically NOT "not signed in": that would tell a correctly-configured account it is broken.
    expect(copy).not.toContain('Not signed in');
  });
});

describe('timeUntil', () => {
  it('answers nothing for an absent or unparseable instant', () => {
    expect(timeUntil(undefined, NOW)).toBeNull();
    expect(timeUntil('not an instant', NOW)).toBeNull();
  });

  it('answers now for an instant that has passed', () => {
    expect(timeUntil(new Date(NOW - 60_000).toISOString(), NOW)).toBe('now');
  });

  it('scales from minutes to days', () => {
    expect(timeUntil(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe('20m');
    expect(timeUntil(new Date(NOW + 5 * 3_600_000).toISOString(), NOW)).toBe('5h');
    expect(timeUntil(new Date(NOW + 3 * 86_400_000).toISOString(), NOW)).toBe('3d');
  });
});

describe('accountUsageReadout', () => {
  it('reports unknown, never zero, when the daemon has no row for this wrapper', () => {
    const readout = accountUsageReadout(undefined, NOW);

    expect(readout.kind).toBe('unknown');
    expect(usageSummary(readout)).toContain('no usage reading');
    expect(usageSummary(readout)).not.toContain('0%');
  });

  it('reports unknown, never zero, when nothing measured this account', () => {
    // `usageBased` absent is the daemon's structural way of saying the probe did not succeed. A reader
    // that defaulted it would turn every unprobed account into a confident zero — including a Codex
    // account, which this build has no probe for at all.
    const readout = accountUsageReadout(usageRow({ authOk: true }), NOW);

    expect(readout).toEqual({ kind: 'unknown', reason: 'nothing on this host has measured this account’s usage' });
    expect(usageSummary(readout)).not.toContain('0%');
  });

  it('tells a shaped-but-empty answer apart from a real measurement', () => {
    const shaped = accountUsageReadout(usageRow({ usageBased: true }), NOW);
    const measured = accountUsageReadout(usageRow({ usageBased: true, fiveHourPercent: 42 }), NOW);

    expect(shaped).toEqual({ kind: 'unknown', reason: 'the provider answered without a usage measurement' });
    expect(measured.kind).toBe('windows');
    expect(usageSummary(shaped)).not.toBe(usageSummary(measured));
  });

  it('reports a token-based account as having no window rather than a zero one', () => {
    const readout = accountUsageReadout(usageRow({ usageBased: false }), NOW);

    expect(readout).toEqual({ kind: 'token-based' });
    expect(usageSummary(readout)).toBe('Token-based — no quota window to report');
    expect(usageSummary(readout)).not.toContain('%');
  });

  it('reports a repudiated credential as a sign-in problem rather than a quota one', () => {
    const readout = accountUsageReadout(usageRow({ authOk: false, usageBased: true, fiveHourPercent: 12 }), NOW);

    expect(readout).toEqual({ kind: 'signed-out' });
    expect(usageSummary(readout)).toContain('Not signed in');
  });

  it('carries both windows under the provider’s own names, with the direction stated', () => {
    const readout = accountUsageReadout(
      usageRow({
        usageBased: true,
        fiveHourPercent: 42,
        weeklyPercent: 13,
        fiveHourResetAt: NOW + 45 * 60_000,
        weeklyResetAt: NOW + 3 * 86_400_000,
      }),
      NOW,
    );

    expect(usageSummary(readout)).toBe('5h 42% used · resets in 45m · weekly 13% used · resets in 3d');
  });

  it('says unknown for the one window a provider did not measure', () => {
    const readout = accountUsageReadout(usageRow({ usageBased: true, fiveHourPercent: 42 }), NOW);

    expect(usageSummary(readout)).toBe('5h 42% used · weekly unknown');
  });

  it('says at limit when the provider declared it, without hiding the numbers', () => {
    const readout = accountUsageReadout(
      usageRow({ usageBased: true, fiveHourPercent: 100, weeklyPercent: 80, atLimit: true }),
      NOW,
    );

    expect(usageSummary(readout)).toBe('5h 100% used · weekly 80% used · at limit');
  });

  it('rounds a fractional percentage rather than rendering it long', () => {
    expect(usageWindowLabel({ window: '5h', usedPercent: 42.4, resetsIn: null })).toBe('5h 42% used');
  });
});
