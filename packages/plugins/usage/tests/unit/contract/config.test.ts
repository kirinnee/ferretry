import { describe, expect, it } from 'bun:test';
import { USAGE_CONFIG, usageLoosens } from '../../../contract/config.ts';

describe('usageLoosens', () => {
  it('holds a FIRST file that switches the public feed on, because a missing file means a private feed', () => {
    // Arrange / Act
    const sentences = usageLoosens(undefined, { publicFeed: true });

    // Assert
    expect(sentences).toEqual(['the usage feed is served to callers with no credential']);
  });

  it('lets a first file that keeps the feed private, or only adds budgets, through', () => {
    expect(usageLoosens(undefined, {})).toEqual([]);
    expect(usageLoosens(undefined, { publicFeed: false })).toEqual([]);
    expect(usageLoosens(undefined, { budgets: { work: { daily: { trigger: 5, hard: 9 } } } })).toEqual([]);
  });

  it('holds only the feed in a first file that adds budgets and switches the feed on', () => {
    const sentences = usageLoosens(undefined, { publicFeed: true, budgets: { work: { daily: { hard: 9 } } } });

    expect(sentences).toEqual(['the usage feed is served to callers with no credential']);
  });

  it('holds a later switch-on, and nothing when the feed was already public or goes private', () => {
    expect(usageLoosens({}, { publicFeed: true })).toHaveLength(1);
    expect(usageLoosens({ publicFeed: false }, { publicFeed: true })).toHaveLength(1);
    expect(usageLoosens({ publicFeed: true }, { publicFeed: true })).toEqual([]);
    expect(usageLoosens({ publicFeed: true }, { publicFeed: false })).toEqual([]);
  });

  it('holds a raised or removed budget limit and lets a lowered or added one through', () => {
    const before = { budgets: { work: { daily: { trigger: 5, hard: 9 } } } };

    expect(usageLoosens(before, { budgets: { work: { daily: { trigger: 6, hard: 9 } } } })).toHaveLength(1);
    expect(usageLoosens(before, { budgets: { work: { daily: { trigger: 5 } } } })).toHaveLength(1);
    expect(usageLoosens(before, {})).toHaveLength(2);
    expect(
      usageLoosens(before, { budgets: { work: { daily: { trigger: 4, hard: 8 }, weekly: { hard: 50 } } } }),
    ).toEqual([]);
  });

  it('is the loosens function the declared config carries', () => {
    expect(USAGE_CONFIG.loosens).toBe(usageLoosens);
  });
});
