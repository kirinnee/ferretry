import { describe, expect, test } from 'bun:test';
import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { foldAnalyticsTurns } from '../../../daemon/lib/analytics/turn-fold.ts';

const AT = '2026-11-07T10:00:00.000Z' as Instant;
const turn = (n: number, extra: Partial<TurnUsage> = {}): TurnUsage => ({
  turn: n,
  at: AT,
  inputTokens: 1_000,
  outputTokens: 100,
  ...extra,
});
const refused = (turns: readonly TurnUsage[]) => foldAnalyticsTurns(turns).usage;

describe('foldAnalyticsTurns', () => {
  test('refuses a ferret whose turns cannot be asked for, or that has none', () => {
    expect(foldAnalyticsTurns(undefined)).toEqual({
      usage: { kind: 'refused', reason: 'transcript_unresolved' },
      activity: { activeDurationMs: null, turns: null },
    });
    expect(foldAnalyticsTurns([])).toEqual({
      usage: { kind: 'refused', reason: 'no_usage_evidence' },
      activity: { activeDurationMs: null, turns: 0 },
    });
  });

  test('refuses a turn whose cache reads and writes are more than its gross input', () => {
    expect(refused([turn(1, { cacheReadTokens: 800, cacheWriteTokens: 300 })])).toEqual({
      kind: 'refused',
      reason: 'ambiguous_token_accounting',
    });
  });

  test('refuses a negative or fractional count, and a total that is no longer a safe integer', () => {
    expect(refused([turn(1, { outputTokens: -1 })])).toMatchObject({ reason: 'ambiguous_token_accounting' });
    expect(refused([turn(1, { inputTokens: 1.5 })])).toMatchObject({ reason: 'ambiguous_token_accounting' });
    const big = Number.MAX_SAFE_INTEGER;
    expect(refused([turn(1, { inputTokens: big }), turn(2, { inputTokens: big })])).toEqual({
      kind: 'refused',
      reason: 'ambiguous_token_accounting',
    });
  });

  test('sums the turns, names the one model they share, and counts the turns', () => {
    const folded = foldAnalyticsTurns([
      turn(1, { model: 'claude-opus-5-5', cacheReadTokens: 200 }),
      turn(2, { model: 'claude-opus-5-5', cacheWriteTokens: 100 }),
    ]);
    expect(folded.activity).toEqual({ activeDurationMs: null, turns: 2 });
    expect(folded.usage).toMatchObject({
      kind: 'usage',
      usage: { inputTokens: 2_000, outputTokens: 200, cachedInputTokens: 200, cacheWriteInputTokens: 100 },
    });
  });

  test('leaves the pricing model unnamed when the turns span more than one model', () => {
    const folded = foldAnalyticsTurns([turn(1, { model: 'claude-opus-5-5' }), turn(2, { model: 'claude-sonnet-5-5' })]);
    expect(folded.usage).toMatchObject({ kind: 'usage', usage: { pricingModel: null } });
  });
});
