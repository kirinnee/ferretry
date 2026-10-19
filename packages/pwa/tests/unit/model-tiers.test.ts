import { describe, expect, test } from 'bun:test';
import {
  asModelTier,
  CUSTOM_MODEL_ID,
  contextWords,
  groupByTier,
  MODEL_TIER_LABELS,
  type ModelTier,
} from '../../src/lib/model-tiers.ts';

describe('model tiers', () => {
  test('reads a tier from an untrusted value', () => {
    expect(asModelTier('fast')).toBe('fast');
    expect(asModelTier('ultra')).toBeUndefined();
    expect(asModelTier(3)).toBeUndefined();
  });

  test('says a context window in words', () => {
    expect(contextWords(1_000_000)).toBe('1M context');
    expect(contextWords(1_050_000)).toBe('1.1M context');
    expect(contextWords(256_000)).toBe('256K context');
    expect(contextWords(undefined)).toBeUndefined();
    expect(contextWords(0)).toBeUndefined();
  });

  test('groups by tier, most capable first, and keeps an untiered list as it was', () => {
    const groups = groupByTier([
      { id: 'quick', tier: 'fast' as const },
      { id: 'big', tier: 'best' as const },
      { id: 'mystery' },
      { id: 'quicker', tier: 'fast' as const },
    ]);
    expect(groups.map(group => [group.heading, group.items.map(item => item.id)])).toEqual([
      [MODEL_TIER_LABELS.best, ['big']],
      [MODEL_TIER_LABELS.fast, ['quick', 'quicker']],
      ['Other', ['mystery']],
    ]);
    expect(groupByTier<{ id: string; tier?: ModelTier }>([{ id: 'a' }])).toEqual([
      { tier: undefined, heading: undefined, items: [{ id: 'a' }] },
    ]);
    expect(groupByTier([])).toEqual([]);
    expect(groupByTier([{ id: 'a', tier: 'best' as const }]).map(group => group.heading)).toEqual(['Most capable']);
  });

  test('takes one word a CLI reads as a model id', () => {
    expect(CUSTOM_MODEL_ID.test('~anthropic/claude-opus-latest[1m]')).toBe(true);
    expect(CUSTOM_MODEL_ID.test('two words')).toBe(false);
    expect(CUSTOM_MODEL_ID.test('$(boom)')).toBe(false);
  });
});
