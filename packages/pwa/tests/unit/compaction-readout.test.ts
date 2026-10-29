import { describe, expect, test } from 'bun:test';
import type { SessionCompactionDone, SessionCompactionRunning } from '@ferretry/protocol';
import {
  compactionDoneReadout,
  compactionRunningReadout,
  compactionStripIndex,
} from '../../src/lib/compaction-readout.ts';

const START = '2026-01-02T03:04:05.000Z';
const running = (extra: Partial<SessionCompactionRunning> = {}): SessionCompactionRunning => ({
  phase: 'running',
  startedAt: START,
  expectedMs: 60_000,
  basis: 'history',
  ...extra,
});

describe('compactionRunningReadout', () => {
  test('with the harness’s own percent, says that figure and the tokens written — and no estimate', () => {
    const readout = compactionRunningReadout(
      running({ tokensBefore: 412_345, percent: 49, tokensWritten: 37_400 }),
      434,
    );
    expect(readout).toEqual({
      percent: 49,
      elapsed: '7m 14s',
      from: '412k tokens',
      written: '37k tokens written',
      usual: null,
      overdue: false,
      valueText: '49 percent',
    });
  });

  test('never calls a real percent overdue, however long it has run', () => {
    const readout = compactionRunningReadout(running({ percent: 12 }), 3_000);
    expect(readout.percent).toBe(12);
    expect(readout.overdue).toBe(false);
    expect(readout.usual).toBeNull();
  });

  test('with no percent reported, derives none: it says the usual duration and the real clock', () => {
    const readout = compactionRunningReadout(running({ tokensBefore: 412_345 }), 24);
    expect(readout).toEqual({
      percent: null,
      elapsed: '24s',
      from: '412k tokens',
      written: null,
      usual: 'Usually ~60s here',
      overdue: false,
      valueText: 'Compacting context',
    });
  });

  test('says the timing is typical when there is no history, and omits a start it never read', () => {
    const readout = compactionRunningReadout(running({ basis: 'typical', expectedMs: 40_000 }), 6);
    expect(readout.from).toBeNull();
    expect(readout.usual).toBe('Usually ~40s — typical timing, no history on this machine yet');
  });

  test('rounds a long usual duration to minutes', () => {
    expect(compactionRunningReadout(running({ expectedMs: 300_000 }), 1).usual).toBe('Usually ~5m here');
  });

  test('admits it is running long, with still no percent, once the usual time is spent', () => {
    const readout = compactionRunningReadout(running(), 130);
    expect(readout.percent).toBeNull();
    expect(readout.overdue).toBe(true);
    expect(readout.elapsed).toBe('2m 10s');
    expect(readout.usual).toBe('Taking longer than usual — still working');
  });
});

describe('compactionDoneReadout', () => {
  const done = (extra: Partial<SessionCompactionDone> = {}): SessionCompactionDone => ({
    phase: 'done',
    endedAt: '2026-01-02T03:04:46.000Z',
    ...extra,
  });

  test('says freed tokens, before → after and how long it took', () => {
    expect(
      compactionDoneReadout(done({ startedAt: START, tokensBefore: 412_000, tokensAfter: 38_000, trigger: 'manual' })),
    ).toEqual({ headline: 'Context compacted', facts: ['412k → 38k', 'freed 374k', '41s'] });
  });

  test('names an automatic compaction', () => {
    expect(compactionDoneReadout(done({ trigger: 'auto' })).headline).toBe('Context auto-compacted');
  });

  test('with only the size it began from, says only that — no invented freed figure', () => {
    expect(compactionDoneReadout(done({ tokensBefore: 90_500 })).facts).toEqual(['was 90k tokens']);
  });

  test('a context that grew has no freed figure', () => {
    expect(compactionDoneReadout(done({ tokensBefore: 1_000, tokensAfter: 2_000 })).facts).toEqual(['1.0k → 2.0k']);
  });

  test('an end before its start leaves the duration out', () => {
    expect(compactionDoneReadout(done({ startedAt: '2026-01-02T03:05:00.000Z' })).facts).toEqual([]);
  });

  test('says nothing more than the headline when nothing was measured', () => {
    expect(compactionDoneReadout(done())).toEqual({ headline: 'Context compacted', facts: [] });
  });
});

describe('compactionStripIndex', () => {
  const done: SessionCompactionDone = { phase: 'done', endedAt: '2026-01-02T03:04:46.000Z' };
  const at = Date.parse(done.endedAt);

  test('sits before the first row stamped after it', () => {
    expect(compactionStripIndex(done, [{ at: at - 5_000 }, { at: at + 1_000 }, { at: at + 9_000 }])).toBe(1);
  });

  test('sits at the tail when nothing is newer, and in an empty transcript', () => {
    expect(compactionStripIndex(done, [{ at: at - 5_000 }])).toBe(1);
    expect(compactionStripIndex(done, [])).toBe(0);
  });

  test('is an earlier page’s event when it ended before the oldest loaded row', () => {
    expect(compactionStripIndex(done, [{ at: at + 1_000 }])).toBeNull();
  });

  test('skips unstamped rows and falls to the tail when none are stamped', () => {
    expect(compactionStripIndex(done, [{}, { at: at - 1_000 }, { at: at + 1_000 }])).toBe(2);
    expect(compactionStripIndex(done, [{}, {}])).toBe(2);
  });

  test('an unreadable instant has no place', () => {
    expect(compactionStripIndex({ phase: 'done', endedAt: 'not a date' }, [{ at: 1 }])).toBeNull();
  });
});
