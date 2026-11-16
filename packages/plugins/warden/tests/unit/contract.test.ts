import { describe, expect, test } from 'bun:test';
import { fakeWarden, wardenConformance } from '../../contract/testing/index.ts';
import {
  DEFAULT_WARDEN_CONFIG,
  effectiveWardenConfig,
  WardenAnomalyKindSchema,
  WardenConfigSchema,
  WardenFileSchema,
  type WardenFile,
  WardenLeaveRequestSchema,
  WardenRunRequestSchema,
  wardenLoosens,
} from '../../contract/index.ts';

wardenConformance('fakeWarden', () => fakeWarden());

describe('warden wire schemas', () => {
  test('the default settings are valid and free: both triage layers off, stop never alone', () => {
    expect(WardenConfigSchema.safeParse(DEFAULT_WARDEN_CONFIG).success).toBe(true);
    expect(DEFAULT_WARDEN_CONFIG.layers).toEqual({ jev: false, llm: false });
    expect(DEFAULT_WARDEN_CONFIG.mayActAlone.stop).toBe(false);
  });
  test('the file refuses the old single `triage` key and any unknown key', () => {
    expect(WardenFileSchema.safeParse({ triage: 'jev' }).success).toBe(false);
    expect(WardenFileSchema.safeParse({ caps: { jevUsdPerDay: 1 } }).success).toBe(true);
    expect(WardenFileSchema.safeParse({ caps: { jevUsdPerDay: 1, extra: 2 } }).success).toBe(false);
  });
  test('the sweep runs every 1, 2, 5, 10 or 15 minutes', () => {
    expect(WardenFileSchema.safeParse({ intervalMinutes: 5 }).success).toBe(true);
    expect(WardenFileSchema.safeParse({ intervalMinutes: 3 }).success).toBe(false);
  });
  test('a run does not spawn unless asked, and a leave names how long', () => {
    expect(WardenRunRequestSchema.parse({})).toEqual({ spawn: false });
    expect(WardenLeaveRequestSchema.safeParse({ ferret: 'f1', duration: '2h' }).success).toBe(false);
  });
  test('the orphaned card flag uses the card word', () => {
    expect(WardenAnomalyKindSchema.safeParse('orphaned_card').success).toBe(true);
    expect(WardenAnomalyKindSchema.safeParse('orphaned_task').success).toBe(false);
  });
  test('a file merges over the default one level into each section', () => {
    const config = effectiveWardenConfig({ caps: { jevUsdPerDay: 1 }, intervalMinutes: 5 });
    expect(config.caps).toEqual({ ...DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 1 });
    expect(config.intervalMinutes).toBe(5);
  });
});

describe('warden loosening (§7.2)', () => {
  test('switching a layer on, letting it stop alone or raising a cap loosens', () => {
    expect(wardenLoosens(undefined, { layers: { jev: true } })).toEqual(['jev triage is switched on']);
    expect(wardenLoosens(undefined, { mayActAlone: { stop: true } })).toEqual(['the warden may stop alone']);
    expect(wardenLoosens(undefined, { caps: { investigationUsdPerDay: 5 } })).toEqual([
      'the investigationUsdPerDay cap is raised',
    ]);
  });
  test('lowering a cap, switching off or an unchanged file does not loosen', () => {
    expect(wardenLoosens({ layers: { jev: true } }, { layers: { jev: false } })).toEqual([]);
    expect(wardenLoosens(undefined, { caps: { jevUsdPerDay: 0.1 }, enabled: false })).toEqual([]);
    expect(wardenLoosens(undefined, {})).toEqual([]);
  });
  /**
   * Today's edit pairs (rebuild-ref `kinds.test.ts`, `wardenLoosening` and `autoMigrateLoosening`) run through 5.0's
   * rule, each with today's sentence: the eight holds 5.0 missed (round-3 review N3).
   */
  const moving = (autoMove: NonNullable<WardenFile['autoMove']>): WardenFile => ({ autoMove });
  const TODAY: readonly (readonly [string, WardenFile, WardenFile, readonly string[]])[] = [
    [
      'lowering the Jev price',
      {},
      { guard: { usdPerMillionInputTokens: 0.01 } },
      ['the Jev price the cap counts with goes down from 0.042 to 0.01'],
    ],
    ['a shorter sweep', {}, { intervalMinutes: 1 }, ['the minutes between Warden sweeps goes down from 2 to 1']],
    [
      'a shorter spawn gap',
      {},
      { minSpawnGapMinutes: 0 },
      ['the minutes between two Warden investigations goes down from 15 to 0'],
    ],
    [
      'switching force-stop on while moves are on',
      moving({ enabled: true }),
      moving({ enabled: true, forceStopBackground: true }),
      ["the Warden may now stop a ferret's own background jobs to move it"],
    ],
    [
      'adding a trigger',
      moving({ enabled: true, when: ['rate_limited'] }),
      moving({ enabled: true, when: ['rate_limited', 'budget_exceeded'] }),
      ['the Warden now also moves a ferret whose login passed its hard spend budget'],
    ],
    [
      'naming a new target',
      moving({ enabled: true, targets: ['claude-b'] }),
      moving({ enabled: true, targets: ['claude-b', 'glm-a'] }),
      ['the Warden may now move ferrets onto glm-a'],
    ],
    [
      'naming a login where any ready one was allowed',
      moving({ enabled: true }),
      moving({ enabled: true, targets: ['glm-a'] }),
      ['the Warden may now move ferrets onto glm-a'],
    ],
    [
      'going from a list to any ready login',
      moving({ enabled: true, targets: ['claude-b'] }),
      moving({ enabled: true, targets: [] }),
      ['the Warden may now move ferrets onto any ready login of the same harness and provider'],
    ],
    [
      'lowering the headroom floor',
      moving({ enabled: true }),
      moving({ enabled: true, minHeadroomPercent: 5 }),
      ['the share a login must have left to be moved onto goes down from 20 to 5'],
    ],
  ];
  for (const [name, before, after, sentences] of TODAY)
    test(`T-0034 today's hold: ${name}`, () => {
      expect(wardenLoosens(before, after)).toEqual(sentences);
    });

  const TIGHTER: readonly (readonly [string, WardenFile, WardenFile])[] = [
    ['raising the Jev price', {}, { guard: { usdPerMillionInputTokens: 0.1 } }],
    ['a longer sweep', {}, { intervalMinutes: 5 }],
    ['a longer spawn gap', {}, { minSpawnGapMinutes: 30 }],
    ['switching force-stop off', moving({ enabled: true, forceStopBackground: true }), moving({ enabled: true })],
    // Force-stop acts only while moves are on: switching it on while they are off moves nothing (switching moves on later is held).
    ['switching force-stop on while moves are off', {}, moving({ forceStopBackground: true })],
    ['dropping a trigger', moving({ enabled: true }), moving({ enabled: true, when: ['rate_limited'] })],
    [
      'dropping a named login',
      moving({ enabled: true, targets: ['claude-b', 'glm-a'] }),
      moving({ enabled: true, targets: ['claude-b'] }),
    ],
    ['raising the headroom floor', moving({ enabled: true }), moving({ enabled: true, minHeadroomPercent: 50 })],
  ];
  for (const [name, before, after] of TIGHTER)
    test(`T-0034 not a loosening, as today: ${name}`, () => {
      expect(wardenLoosens(before, after)).toEqual([]);
    });

  test('T-0034 force-stop already on is held with moves when moves are switched on', () => {
    expect(
      wardenLoosens(moving({ forceStopBackground: true }), moving({ enabled: true, forceStopBackground: true })),
    ).toEqual([
      'the warden may move ferrets between logins',
      "the Warden may now stop a ferret's own background jobs to move it",
    ]);
  });

  test('adding a login to the failover list loosens', () => {
    expect(wardenLoosens(undefined, { accounts: [{ agent: 'a' }] })).toEqual([
      'a login is added to the warden’s failover list',
    ]);
  });
});
