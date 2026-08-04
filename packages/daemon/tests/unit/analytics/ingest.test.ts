import { describe, expect, test } from 'bun:test';
import { gateAnalyticsIngest, TERMINAL_ANALYTICS_STATUSES } from '../../../src/lib/analytics/ingest.ts';

const finished = { createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z' };

describe('gateAnalyticsIngest', () => {
  test('ingests a session that recorded both a terminal status and a finish instant', () => {
    for (const status of TERMINAL_ANALYTICS_STATUSES) {
      expect(gateAnalyticsIngest({ ...finished, status })).toEqual({ kind: 'ingest', status, ...finished });
    }
  });

  test('refuses a live session even when a finish instant was stamped early', () => {
    expect(gateAnalyticsIngest({ ...finished, status: 'running' })).toEqual({
      kind: 'refused',
      reason: 'nonterminal_status',
    });
  });

  test('refuses a kill the daemon could not confirm, because the process may still be spending', () => {
    expect(gateAnalyticsIngest({ ...finished, status: 'kill_failed' })).toEqual({
      kind: 'refused',
      reason: 'nonterminal_status',
    });
  });

  test('refuses a status this daemon does not model rather than reading it as still running', () => {
    expect(gateAnalyticsIngest({ ...finished, status: 'finished' })).toEqual({
      kind: 'refused',
      reason: 'unknown_status',
    });
    expect(gateAnalyticsIngest({ ...finished, status: null })).toEqual({ kind: 'refused', reason: 'unknown_status' });
    expect(gateAnalyticsIngest(finished)).toEqual({ kind: 'refused', reason: 'unknown_status' });
  });

  test('refuses a terminal session whose end was never recorded', () => {
    expect(gateAnalyticsIngest({ createdAt: finished.createdAt, status: 'completed' })).toEqual({
      kind: 'refused',
      reason: 'no_finish_instant',
    });
    expect(gateAnalyticsIngest({ createdAt: finished.createdAt, finishedAt: null, status: 'completed' })).toEqual({
      kind: 'refused',
      reason: 'no_finish_instant',
    });
  });

  test('refuses a finish instant it cannot read instead of measuring from an unparsable value', () => {
    expect(gateAnalyticsIngest({ ...finished, finishedAt: 'whenever', status: 'completed' })).toEqual({
      kind: 'refused',
      reason: 'unreadable_finish_instant',
    });
  });

  test('refuses a session with no readable creation instant, which has no day, week or duration', () => {
    expect(gateAnalyticsIngest({ finishedAt: finished.finishedAt, status: 'stopped' })).toEqual({
      kind: 'refused',
      reason: 'no_creation_instant',
    });
    expect(gateAnalyticsIngest({ createdAt: null, finishedAt: finished.finishedAt, status: 'stopped' })).toEqual({
      kind: 'refused',
      reason: 'no_creation_instant',
    });
    expect(gateAnalyticsIngest({ createdAt: 'yesterday', finishedAt: finished.finishedAt, status: 'stopped' })).toEqual(
      {
        kind: 'refused',
        reason: 'unreadable_creation_instant',
      },
    );
  });
});
