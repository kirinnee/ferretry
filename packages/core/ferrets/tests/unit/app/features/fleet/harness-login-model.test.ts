import { describe, expect, it } from 'bun:test';

import { timeUntil } from '../../../../src/features/fleet/harness-login-model.ts';
import { NOW } from './harness-login-support.ts';

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
