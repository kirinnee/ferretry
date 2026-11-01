import { describe, expect, test } from 'bun:test';
import {
  interactiveFerrets,
  machineCounts,
  machineHealth,
  spendToday,
  TOP_FERRETS,
  topFerrets,
} from '../../src/components/machine-home-model.ts';
import { sessionView } from '../support/sessions.ts';
import { rawRow } from '../support/analytics-rows.ts';
import { wardenAnomaly, wardenStatus } from '../support/warden.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();
const interactive = (id: string, state: Parameters<typeof sessionView>[1] = {}) =>
  sessionView(id, { ...state, config: { mode: 'interactive', ...state.config } });
const asking = (id: string, latestAt: string) =>
  interactive(id, {
    state: { status: 'awaiting_user', attention: { open: 1, first: 'A1', ask: 'Go?', latestAt } as never },
  });

describe('which ferrets the home is about', () => {
  test('keeps live interactive sessions and drops auto, stopped and Pack clean-up helpers', () => {
    const sessions = [
      interactive('live'),
      sessionView('auto'),
      interactive('done', { state: { status: 'completed' } }),
    ];
    expect(interactiveFerrets(sessions).map(view => view.config.id)).toEqual(['live']);
  });
});

describe('the overview numbers', () => {
  test('counts running, waiting on you, live interactive and every session', () => {
    const sessions = [
      interactive('a'),
      interactive('b', { state: { status: 'waiting' } }),
      asking('c', ago(1_000)),
      sessionView('auto'),
    ];
    const counts = machineCounts(sessions);
    expect(counts.interactive).toBe(3);
    expect(counts.waitingOnYou).toBe(1);
    expect(counts.total).toBe(4);
    expect(counts.running).toBeGreaterThanOrEqual(1);
  });

  test('an empty machine counts zero everywhere', () => {
    expect(machineCounts([])).toEqual({ running: 0, waitingOnYou: 0, interactive: 0, total: 0 });
  });
});

describe('the ferrets to open first', () => {
  test('puts the ones that need you first, then the most recently active', () => {
    const sessions = [
      interactive('old', { state: { lastActivityAt: ago(60_000) } }),
      interactive('fresh', { state: { lastActivityAt: ago(1_000) } }),
      asking('ask', ago(5_000)),
    ];
    expect(topFerrets(sessions).map(view => view.config.id)).toEqual(['ask', 'fresh', 'old']);
  });

  test('stops at the limit', () => {
    const sessions = Array.from({ length: TOP_FERRETS + 3 }, (_, index) => interactive(`s${index}`));
    expect(topFerrets(sessions)).toHaveLength(TOP_FERRETS);
  });
});

describe('spend today', () => {
  test('sums the priced sessions that started today, in dollars', () => {
    const rows = [
      rawRow({ id: 'a', equivalentApiCostUsdMicros: 1_500_000 }),
      rawRow({ id: 'b', equivalentApiCostUsdMicros: 2_500_000 }),
      rawRow({ id: 'c', equivalentApiCostUsdMicros: null }),
    ];
    expect(spendToday(rows)).toBe(4);
  });

  test('no sessions today is a true zero', () => {
    expect(spendToday([])).toBe(0);
  });

  test('sessions with no known price is unknown, not zero', () => {
    expect(spendToday([rawRow({ id: 'a', equivalentApiCostUsdMicros: null })])).toBeNull();
  });
});

describe('the health tile', () => {
  test('is unknown until the Warden has answered', () => {
    expect(machineHealth(null, NOW)).toBeNull();
  });

  test('is healthy after a sweep that left nobody waiting', () => {
    const health = machineHealth(wardenStatus({ lastSweepAt: ago(60_000) }), NOW);
    expect(health?.tone).toBe('ok');
    expect(health?.word).toBe('Healthy');
    expect(health?.detail).toContain('Fleet checks');
  });

  test('counts the sessions that need the owner', () => {
    const health = machineHealth(
      wardenStatus({ lastSweepAt: ago(60_000), anomalies: [wardenAnomaly({ sessionId: 'x' })] }),
      NOW,
    );
    expect(health?.tone).toBe('warn');
    expect(health?.word).toBe('1 to look at');
  });

  test('says so when the Warden has not swept yet', () => {
    const health = machineHealth(wardenStatus(), NOW);
    expect(health?.tone).toBe('warn');
    expect(health?.word).toBe('Not swept');
  });
});
