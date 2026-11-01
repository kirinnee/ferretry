import { describe, expect, it } from 'bun:test';
import {
  COMPASS_ROW_PX,
  COMPASS_SIDE_PX,
  compassReading,
  SNOOZE_LENGTHS,
  snoozeUntil,
} from '../../../../src/features/agenda/agenda-compass.ts';
import { swipeThreshold } from '../../../../src/lib/agenda-inbox.ts';

const WIDTH = 390;
const T = swipeThreshold(WIDTH);
const kind = (dx: number, dy: number, available?: { notNeeded: boolean; snooze: boolean }) =>
  compassReading(dx, dy, WIDTH, available).intent.kind;

describe('compassReading', () => {
  it('cancels, with no compass, short of the Skip threshold', () => {
    const reading = compassReading(0, T - 1, WIDTH);
    expect(reading.intent.kind).toBe('cancel');
    expect(reading.revealed).toBe(false);
    expect(reading.slot).toBeNull();
  });

  it('reads plain ↓ past the threshold as Skip, and reveals the compass', () => {
    const reading = compassReading(0, T, WIDTH);
    expect(reading.intent.kind).toBe('skip');
    expect(reading.revealed).toBe(true);
    expect(reading.slot).toBe('down');
  });

  it('reads ↓← as Skip and ↓→ as Not needed', () => {
    expect(compassReading(-COMPASS_SIDE_PX, T + 4, WIDTH).slot).toBe('down-left');
    expect(kind(-COMPASS_SIDE_PX, T + 4)).toBe('skip');
    expect(compassReading(COMPASS_SIDE_PX, T + 4, WIDTH).slot).toBe('down-right');
    expect(kind(COMPASS_SIDE_PX, T + 4)).toBe('not-needed');
  });

  it('keeps a small sideways wobble as plain Skip', () => {
    expect(kind(COMPASS_SIDE_PX - 1, T + 4)).toBe('skip');
    expect(kind(-(COMPASS_SIDE_PX - 1), T + 4)).toBe('skip');
  });

  it('reads ↓↓ as Snooze with no length yet', () => {
    const reading = compassReading(0, T + COMPASS_ROW_PX, WIDTH);
    expect(reading.intent.kind).toBe('snooze-pick');
    expect(reading.slot).toBe('down-down');
  });

  it('picks 1 h, 4 h or 1 day by where the finger is at ↓↓↓', () => {
    const y = T + 2 * COMPASS_ROW_PX;
    expect(compassReading(-COMPASS_SIDE_PX, y, WIDTH).intent).toEqual({ kind: 'snooze', length: '1h' });
    expect(compassReading(0, y, WIDTH).intent).toEqual({ kind: 'snooze', length: '4h' });
    expect(compassReading(COMPASS_SIDE_PX, y, WIDTH).intent).toEqual({ kind: 'snooze', length: '1d' });
    expect(compassReading(COMPASS_SIDE_PX, y, WIDTH).slot).toBe('down-down-1d');
  });

  it('drags back up out of the compass to the row above', () => {
    expect(kind(0, T + 2 * COMPASS_ROW_PX)).toBe('snooze');
    expect(kind(0, T + COMPASS_ROW_PX)).toBe('snooze-pick');
    expect(kind(0, T + 2)).toBe('skip');
    expect(kind(0, T - 2)).toBe('cancel');
  });

  it('reads a direction the host cannot do as the row above it', () => {
    const noSnooze = { notNeeded: true, snooze: false };
    expect(kind(0, T + 3 * COMPASS_ROW_PX, noSnooze)).toBe('skip');
    const noDismiss = { notNeeded: false, snooze: true };
    expect(kind(COMPASS_SIDE_PX, T + 4, noDismiss)).toBe('skip');
    expect(kind(COMPASS_SIDE_PX, T + 3 * COMPASS_ROW_PX, noDismiss)).toBe('snooze');
  });

  it('never reads an upward or a nearly flat drag as a compass', () => {
    expect(kind(0, -200)).toBe('cancel');
    expect(kind(200, 0)).toBe('cancel');
  });
});

describe('snoozeUntil', () => {
  const NOW = Date.parse('2026-11-01T09:00:00.000Z');
  it('adds the length to now', () => {
    expect(snoozeUntil('1h', NOW)).toBe('2026-11-01T10:00:00.000Z');
    expect(snoozeUntil('4h', NOW)).toBe('2026-11-01T13:00:00.000Z');
    expect(snoozeUntil('1d', NOW)).toBe('2026-11-02T09:00:00.000Z');
  });
  it('lists the three lengths in drawing order', () => {
    expect(SNOOZE_LENGTHS.map(length => length.label)).toEqual(['1 h', '4 h', '1 day']);
  });
});
