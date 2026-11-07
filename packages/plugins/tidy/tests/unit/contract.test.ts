import { describe, expect, test } from 'bun:test';
import { fakeTidy, tidyConformance } from '../../contract/testing/index.ts';
import {
  SCRATCH_DEFAULTS,
  ScratchPlanViewSchema,
  ScratchSweepRequestSchema,
  TidyConfigSchema,
  TidyPlanSchema,
  tidyLoosens,
} from '../../contract/index.ts';

tidyConformance('fakeTidy', () => fakeTidy({ reclaimedFerrets: 2, reclaimedBytes: 4096 }));

const config = (scratch: { enabled?: boolean; ttlHours?: number; perSweep?: number }) =>
  TidyConfigSchema.parse({ scratch });

describe('tidy wire', () => {
  test('an empty tidy.yaml reads as today’s defaults', () => {
    expect(TidyConfigSchema.parse({})).toEqual({ scratch: SCRATCH_DEFAULTS });
  });
  test('a plan names the ferret and nothing about a session or a version', () => {
    const plan = { ferret: 'lead', helper: false, drop: [], close: [], keep: [] };
    expect(TidyPlanSchema.safeParse(plan).success).toBe(true);
    expect(TidyPlanSchema.safeParse({ ...plan, v: 1 }).success).toBe(false);
  });
  test('a plan keeps a card by its id and an ask by its A-number', () => {
    const keep = [
      { kind: 'card', id: 'F1', title: 'a', code: 'board-on', why: 'w' },
      { kind: 'ask', id: 'A3', title: 'b', code: 'gate', why: 'w' },
    ];
    expect(TidyPlanSchema.safeParse({ ferret: 'lead', helper: false, drop: [], close: [], keep }).success).toBe(true);
    const wrong = [{ kind: 'ask', id: 'F1', title: 'b', code: 'gate', why: 'w' }];
    expect(TidyPlanSchema.safeParse({ ferret: 'lead', helper: false, drop: [], close: [], keep: wrong }).success).toBe(
      false,
    );
  });
  test('an ineligible scratch plan must say why', () => {
    const base = { ferret: 'lead', directory: '/x', bytes: 0, entries: [] };
    expect(ScratchPlanViewSchema.safeParse({ ...base, eligible: true }).success).toBe(true);
    expect(ScratchPlanViewSchema.safeParse({ ...base, eligible: false }).success).toBe(false);
    expect(ScratchPlanViewSchema.safeParse({ ...base, eligible: false, reason: 'a git worktree' }).success).toBe(true);
  });
  test('a sweep request takes a force flag and nothing else', () => {
    expect(ScratchSweepRequestSchema.parse({})).toEqual({ force: false });
    expect(ScratchSweepRequestSchema.safeParse({ force: true, extra: 1 }).success).toBe(false);
  });
});

describe('tidy config loosening', () => {
  test('switching the automatic sweep on, waiting less or sweeping more is held for the owner', () => {
    expect(tidyLoosens(config({ enabled: false }), config({ enabled: true }))).toHaveLength(1);
    expect(tidyLoosens(config({ ttlHours: 24 }), config({ ttlHours: 1 }))).toHaveLength(1);
    expect(tidyLoosens(config({ perSweep: 20 }), config({ perSweep: 40 }))).toHaveLength(1);
  });
  test('switching it off, waiting longer or sweeping less is not', () => {
    expect(tidyLoosens(config({}), config({ enabled: false }))).toEqual([]);
    expect(tidyLoosens(config({}), config({ ttlHours: 48, perSweep: 5 }))).toEqual([]);
  });
  test('a new file is judged against the defaults, so writing the defaults loosens nothing', () => {
    expect(tidyLoosens(undefined, config({}))).toEqual([]);
    expect(tidyLoosens(undefined, config({ ttlHours: 2 }))).toHaveLength(1);
  });
});
