import { expect, test } from 'bun:test';
import {
  COMPACTION_HISTORY_KEY,
  CompactionHistoryHook,
  CompactionRecordSchema,
  MAX_COMPACTION_MS,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

test('ferrets.compaction-history is offered by Ferrets and names Usage as its one taker', () => {
  expect(manifest.hooks.offers.map(offer => offer.hook.name)).toContain('ferrets.compaction-history');
  expect(CompactionHistoryHook.mode).toBe('provide');
  expect(CompactionHistoryHook.takers).toEqual(['usage']);
  expect(CompactionHistoryHook.key.safeParse(COMPACTION_HISTORY_KEY).success).toBe(true);
  expect(CompactionHistoryHook.key.safeParse('anything-else').success).toBe(false);
});

test('a compaction record is a harness, a bounded positive duration and an instant, and nothing else', () => {
  const record = { harness: 'claude', durationMs: 30_000, at: '2026-11-14T10:00:00.000Z' };

  expect(CompactionRecordSchema.safeParse(record).success).toBe(true);
  expect(CompactionRecordSchema.safeParse({ ...record, durationMs: MAX_COMPACTION_MS + 1 }).success).toBe(false);
  expect(CompactionRecordSchema.safeParse({ ...record, durationMs: 0 }).success).toBe(false);
  expect(CompactionRecordSchema.safeParse({ ...record, text: 'a summary' }).success).toBe(false);
});
