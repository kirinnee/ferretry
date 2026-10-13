import { describe, expect, it } from 'bun:test';

import {
  absoluteInstantLabel,
  accountHealthView,
  lastCheckedAt,
  relativeInstantLabel,
  UNREAD_ACCOUNT_HEALTH,
} from '../../src/lib/account-health-view.ts';
import type { PickerAccountHealth } from '../../src/lib/account-picker-catalog.ts';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const FOUR_MINUTES_AGO = new Date(NOW - 240_000).toISOString();

const health = (overrides: Partial<PickerAccountHealth> = {}): PickerAccountHealth => ({
  credentialId: 'claude-work',
  word: 'ready',
  label: 'Ready',
  reason: 'provider_accepted',
  explanation: 'Ready. The provider accepted this login.',
  lastCheckedAt: FOUR_MINUTES_AGO,
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
    expect(relativeInstantLabel(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('absoluteInstantLabel', () => {
  it('is the exact UTC instant, for the accessible name rather than the visible label', () => {
    expect(absoluteInstantLabel(NOW)).toBe('2026-08-24T12:00:00.000Z');
  });
});

describe('lastCheckedAt', () => {
  it('reads the ISO instant as epoch milliseconds', () => {
    expect(lastCheckedAt(health())).toBe(NOW - 240_000);
  });

  it('is null when nobody has checked, and for an instant it cannot read', () => {
    const { lastCheckedAt: _omitted, ...never } = health();
    expect(lastCheckedAt(never)).toBeNull();
    expect(lastCheckedAt(health({ lastCheckedAt: 'not a time' }))).toBeNull();
  });
});

describe('accountHealthView', () => {
  it('prints the daemon’s own word and sentence, and when it was checked', () => {
    expect(accountHealthView(health(), NOW)).toEqual({
      label: 'Ready',
      checked: 'Checked 4m ago',
      detail: 'Ready. The provider accepted this login.',
      tone: 'ok',
      offersSignIn: false,
    });
  });

  it('says never checked rather than inventing a time', () => {
    const { lastCheckedAt: _omitted, ...never } = health({ word: 'checking', label: 'Checking' });
    const actual = accountHealthView(never, NOW);
    expect(actual.checked).toBe('Never checked');
    expect(actual.tone).toBe('muted');
    expect(actual.secondary).toBeUndefined();
  });

  it('paints each status word in its own tone, and offers sign-in only where it can help', () => {
    const refresh = accountHealthView(health({ word: 'refresh_due', label: 'Refresh due' }), NOW);
    expect(refresh).toMatchObject({ label: 'Refresh due', tone: 'warn', offersSignIn: false });
    const signIn = accountHealthView(
      health({ word: 'needs_sign_in', label: 'Needs sign-in', reason: 'not_signed_in' }),
      NOW,
    );
    expect(signIn).toMatchObject({ label: 'Needs sign-in', tone: 'bad', offersSignIn: true });
  });

  it('adds a second clause when the newest check could not conclude', () => {
    const actual = accountHealthView(health({ lastCheckInconclusive: true }), NOW);
    expect(actual.secondary).toBe('The check 4m ago was inconclusive.');
  });

  it('says nothing about an inconclusive check nobody can date', () => {
    const { lastCheckedAt: _omitted, ...never } = health({ lastCheckInconclusive: true });
    expect(accountHealthView(never, NOW).secondary).toBeUndefined();
  });
});

describe('UNREAD_ACCOUNT_HEALTH', () => {
  it('is unread, not unhealthy', () => {
    expect(UNREAD_ACCOUNT_HEALTH).toMatchObject({
      label: 'Unknown',
      checked: 'Never checked',
      tone: 'muted',
      offersSignIn: false,
    });
  });
});
