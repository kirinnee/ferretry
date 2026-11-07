import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { downgradeOf, downgradeSentence } from '../../../../src/features/session-actions/context-downgrade.ts';

describe('a smaller context window, in words', () => {
  const numbers = { model: 'm', targetWindow: 200_000, currentWindow: 1_000_000 };

  it('says what the window becomes, for a restart and for a move', () => {
    expect(downgradeSentence(numbers)).toBe(
      'Restarting would give this conversation a smaller window — 200,000 tokens instead of 1,000,000 — so part of it would be cut off.',
    );
    expect(downgradeSentence(numbers, 'Moving')).toStartWith('Moving would give this conversation');
    expect(downgradeSentence(null)).toBe(
      'Restarting would give this conversation a smaller window, so part of it would be cut off.',
    );
  });

  it('reads the numbers from the body first, then from the older sentence, else nothing', () => {
    const body = new FyHttpError('x', 409, 'context_downgrade_refused', {
      error: 'x',
      code: 'context_downgrade_refused',
      downgrade: numbers,
    });
    const sentence = new FyHttpError(
      'a serves m with a 200000-token window and this session is running in 1000000; truncated',
      409,
      'context_downgrade_refused',
    );
    const neither = new FyHttpError('nothing useful', 409, 'context_downgrade_refused', { error: 'nothing useful' });
    expect(downgradeOf(body)).toEqual(numbers);
    expect(downgradeOf(sentence)).toEqual(numbers);
    expect(downgradeOf(neither)).toBeNull();
  });
});
