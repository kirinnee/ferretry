/** Parity rows F-0130, F-0230, F-0231, F-0253, F-0254, F-0255 (docs/design/rebuild-parity.md, usage). */
import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  COMPACTION_HISTORY_STATE,
  CompactionHistoryFileSchema,
  PAUSE_TOLD_STATE,
  PAUSES_STATE,
  INSIGHTS_STATE,
  type Pause,
} from '../../../contract/index.ts';
import { PausesStore, ToldStore } from '../../../daemon/adapters/budget/ports.ts';
import { StateCompactionHistory } from '../../../daemon/adapters/usage/state-compaction-history.ts';
import manifest from '../../../manifest.ts';
import { usageHost } from './host.ts';

/** A state port that keeps what it is given by declared file, or answers a damaged file when told to. */
function memoryState(damaged = false) {
  const files = new Map<string, unknown>();
  const touched: string[] = [];
  const port = {
    read: async (file: { path: string }) => {
      touched.push(file.path);
      return damaged ? { ok: false, error: { code: 'invalid' } } : { ok: true, value: files.get(file.path) };
    },
    write: async (file: { path: string }, value: unknown) => {
      touched.push(file.path);
      files.set(file.path, value);
    },
  } as unknown as StatePort;
  return { port, files, touched };
}

const PAUSE: Pause = {
  period: 'daily',
  level: 'over_hard',
  limitUsd: 60,
  resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
  timeZone: 'UTC',
};

describe('the usage state files', () => {
  test('F-0230 the pauses in force are kept in pauses.json under the usage state folder, format 1, and read back', async () => {
    expect([PAUSES_STATE.path, PAUSES_STATE.store, PAUSES_STATE.format]).toEqual(['pauses.json', 'json', 1]);
    expect(manifest.data.state.map(file => file.path)).toContain('pauses.json');
    const state = memoryState();
    const store = new PausesStore(state.port);

    expect(await store.read()).toEqual({});
    await store.write({ liftoff: PAUSE });

    expect(await store.read()).toEqual({ liftoff: PAUSE });
    expect(state.touched.every(path => path === PAUSES_STATE.path)).toBe(true);
  });

  test('F-0230 a damaged pauses file is refused, never read as "nothing paused"', async () => {
    await expect(new PausesStore(memoryState(true).port).read()).rejects.toThrow('damaged');
  });

  test('F-0231 the (login, period) the owner was told about are kept in pause-told.json, format 1, and read back', async () => {
    expect([PAUSE_TOLD_STATE.path, PAUSE_TOLD_STATE.store, PAUSE_TOLD_STATE.format]).toEqual([
      'pause-told.json',
      'json',
      1,
    ]);
    const state = memoryState();
    const store = new ToldStore(state.port);

    expect(await store.read()).toEqual([]);
    await store.write(['liftoff|daily|2026-10-30T00:00:00.000Z']);

    expect(await store.read()).toEqual(['liftoff|daily|2026-10-30T00:00:00.000Z']);
    expect(state.touched.every(path => path === PAUSE_TOLD_STATE.path)).toBe(true);
    await expect(new ToldStore(memoryState(true).port).read()).rejects.toThrow('damaged');
  });

  test('F-0253 the insights index is a database file the daemon half opens at build, declared as a rebuildable cache', async () => {
    expect([INSIGHTS_STATE.path, INSIGHTS_STATE.store, INSIGHTS_STATE.format]).toEqual([
      'analytics.sqlite',
      'sqlite-cache',
      1,
    ]);
    const { host } = await usageHost();

    expect([...host.state('usage').databases.keys()]).toEqual(['analytics.sqlite']);
    await host.stop();
  });

  test('F-0130 the compaction history is kept in compaction-history.json under the usage state folder, format 1, and read back', async () => {
    const state = memoryState();
    const history = new StateCompactionHistory(state.port);
    const entry = { harness: 'claude', durationMs: 42_000, at: '2026-11-14T10:00:00.000Z' } as const;

    expect([COMPACTION_HISTORY_STATE.path, COMPACTION_HISTORY_STATE.store, COMPACTION_HISTORY_STATE.format]).toEqual([
      'compaction-history.json',
      'json',
      1,
    ]);
    expect(manifest.data.state).toContain(COMPACTION_HISTORY_STATE);
    expect(await history.durations('claude', undefined)).toEqual([]);
    await history.record(entry);

    expect(await history.durations('claude', undefined)).toEqual([42_000]);
    expect(state.files.get(COMPACTION_HISTORY_STATE.path)).toEqual({ entries: [entry] });
    expect(state.touched.every(path => path === COMPACTION_HISTORY_STATE.path)).toBe(true);
    // An entry the schema refuses (a run longer than any compaction) is not a record of one.
    expect(CompactionHistoryFileSchema.safeParse({ entries: [{ ...entry, durationMs: 31 * 60_000 }] }).success).toBe(
      false,
    );
  });
});
