import { describe, expect, test } from 'bun:test';
import { fakeWarden, wardenConformance } from '../../contract/testing/index.ts';
import {
  DEFAULT_WARDEN_CONFIG,
  effectiveWardenConfig,
  WardenAnomalyKindSchema,
  WardenConfigSchema,
  WardenFileSchema,
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
  test('adding a login to the failover list loosens', () => {
    expect(wardenLoosens(undefined, { accounts: [{ agent: 'a' }] })).toEqual([
      'a login is added to the warden’s failover list',
    ]);
  });
});
