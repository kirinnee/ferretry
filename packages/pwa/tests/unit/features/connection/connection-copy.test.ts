import { describe, expect, it } from 'bun:test';
import {
  carrierLines,
  DETAILS_COPY,
  outageDuration,
  pillDetail,
  stallCopy,
} from '../../../../src/features/connection/connection-copy.ts';
import type { ConnectionHealthState } from '../../../../src/lib/connection-health.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

const reconnecting = (overrides: Partial<Reconnecting> = {}): Reconnecting => ({
  kind: 'reconnecting',
  since: NOW - 5_000,
  attempt: 1,
  nextAttemptAt: null,
  failures: [],
  cause: 'unknown',
  stalled: false,
  ...overrides,
});

describe('pillDetail', () => {
  it('names the attempt once there has been a retry', () => {
    expect(pillDetail(reconnecting({ attempt: 2, nextAttemptAt: NOW + 4_000 }), NOW)).toBe('attempt 2');
  });

  it('counts down to a scheduled first retry, rounding up', () => {
    expect(pillDetail(reconnecting({ nextAttemptAt: NOW + 2_100 }), NOW)).toBe('retrying in 3s');
  });

  it('says nothing more while a first retry is in flight or already due', () => {
    expect(pillDetail(reconnecting(), NOW)).toBeNull();
    expect(pillDetail(reconnecting({ nextAttemptAt: NOW }), NOW)).toBeNull();
  });
});

describe('outageDuration', () => {
  it('reads seconds, minutes and hours, singular and plural', () => {
    expect(outageDuration(NOW - 1_000, NOW)).toBe('1 second');
    expect(outageDuration(NOW - 42_000, NOW)).toBe('42 seconds');
    expect(outageDuration(NOW - 60_000, NOW)).toBe('1 minute');
    expect(outageDuration(NOW - 5 * 60_000, NOW)).toBe('5 minutes');
    expect(outageDuration(NOW - 2 * 3_600_000, NOW)).toBe('2 hours');
  });

  it('never reads negative when the clock is behind the outage', () => {
    expect(outageDuration(NOW + 3_000, NOW)).toBe('0 seconds');
  });
});

describe('DETAILS_COPY', () => {
  it('counts one attempt and many', () => {
    expect(DETAILS_COPY.attempts(1)).toBe('1 automatic attempt');
    expect(DETAILS_COPY.attempts(3)).toBe('3 automatic attempts');
  });
});

describe('stallCopy', () => {
  it('gives each cause one heading and one sentence', () => {
    expect(stallCopy('device-offline', 'workbench')).toEqual({
      heading: 'This device is offline',
      advice: 'Check Wi-Fi or mobile data. Ferretry reconnects on its own.',
    });
    expect(stallCopy('daemon-unreachable', 'workbench')).toEqual({
      heading: 'workbench is asleep or its daemon is stopped',
      advice: 'Wake the machine, or start its daemon by running fyd on it.',
    });
    expect(stallCopy('relay-unreachable', 'workbench')).toEqual({
      heading: 'The relay is unreachable',
      advice: 'It usually comes back on its own. Switching to Wi-Fi can help meanwhile.',
    });
    expect(stallCopy('unknown', 'workbench')).toEqual({
      heading: 'Can’t reach workbench',
      advice: 'Still retrying on its own.',
    });
  });
});

describe('carrierLines', () => {
  it('keeps the first line for each carrier and drops repeats', () => {
    expect(
      carrierLines([
        { label: 'Direct', detail: 'direct was not reachable (1006)' },
        { label: 'Hosted relay', detail: 'the relay socket closed (1006)' },
        { label: 'Direct', detail: 'direct was not reachable (1006)' },
      ]),
    ).toEqual([
      { label: 'Direct', detail: 'direct was not reachable (1006)' },
      { label: 'Hosted relay', detail: 'the relay socket closed (1006)' },
    ]);
  });
});
