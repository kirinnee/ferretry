import { describe, expect, it } from 'bun:test';
import {
  INPUT_LOCK_REASONS,
  INPUT_LOCK_WORDS,
  INPUT_QUARANTINE_SECONDS,
  INPUT_SHORT_LOCK_SECONDS,
  InputAgentViewSchema,
  InputLockSchema,
  lockWords,
} from '../../src/lib/input-request.ts';

describe('the lock a card shows', () => {
  it('should be a number of seconds within the full window, and one of the fixed reasons', () => {
    expect(InputLockSchema.safeParse({ seconds: INPUT_SHORT_LOCK_SECONDS, reason: 'probed-field' }).success).toBe(true);
    expect(InputLockSchema.safeParse({ seconds: INPUT_QUARANTINE_SECONDS + 1, reason: 'not-proven' }).success).toBe(
      false,
    );
    expect(InputLockSchema.safeParse({ seconds: 0, reason: 'not-proven' }).success).toBe(false);
    expect(InputLockSchema.safeParse({ seconds: 10, reason: 'the agent says so' }).success).toBe(false);
    expect(InputLockSchema.safeParse({ seconds: 10, reason: 'probed-field', note: 'x' }).success).toBe(false);
  });

  it('should say every reason in a fixed sentence, and the length in words', () => {
    for (const reason of INPUT_LOCK_REASONS) expect(INPUT_LOCK_WORDS[reason].length).toBeGreaterThan(10);
    expect(lockWords({ seconds: 10, reason: 'probed-field' })).toBe('10 s');
    expect(lockWords({ seconds: 120, reason: 'not-proven' })).toBe('2 minutes');
    expect(lockWords({ seconds: 60, reason: 'not-proven' })).toBe('1 minute');
  });

  it('should tell the agent the seconds, and nothing else about it', () => {
    expect(InputAgentViewSchema.safeParse({ id: 'A7', state: 'delivered', lockSeconds: 10 }).success).toBe(true);
    expect(InputAgentViewSchema.safeParse({ id: 'A7', state: 'delivered', lockSeconds: 121 }).success).toBe(false);
  });
});
