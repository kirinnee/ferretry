import { describe, expect, it } from 'bun:test';
import {
  COMPASS_PICK_PX,
  COMPASS_ROW_PX,
  COMPASS_SIDE_PX,
  compassReading,
} from '../../../../src/features/agenda/agenda-compass.ts';
import { swipeThreshold } from '../../../../src/lib/agenda-inbox.ts';
import { SNOOZE_PICK_IDS } from '../../../../src/lib/agenda-snooze.ts';

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

  it('picks one of the shared snooze choices by where the finger is at ↓↓↓', () => {
    const y = T + 2 * COMPASS_ROW_PX;
    const pick = (dx: number) => compassReading(dx, y, WIDTH).intent;
    expect(pick(-2 * COMPASS_PICK_PX)).toEqual({ kind: 'snooze', pick: 'hour' });
    expect(pick(-COMPASS_PICK_PX / 2)).toEqual({ kind: 'snooze', pick: 'hours' });
    expect(pick(COMPASS_PICK_PX / 2)).toEqual({ kind: 'snooze', pick: 'tomorrow' });
    expect(pick(2 * COMPASS_PICK_PX)).toEqual({ kind: 'snooze', pick: 'custom' });
    expect(compassReading(2 * COMPASS_PICK_PX, y, WIDTH).slot).toBe('down-down-custom');
    expect(pick(-1000)).toEqual({ kind: 'snooze', pick: 'hour' });
    expect(pick(1000)).toEqual({ kind: 'snooze', pick: 'custom' });
  });

  it('has a place for every choice of the shared list, in its order, and no other', () => {
    const y = T + 2 * COMPASS_ROW_PX;
    const reached = new Set<string>();
    for (let dx = -300; dx <= 300; dx += 8) {
      const { intent } = compassReading(dx, y, WIDTH);
      if (intent.kind === 'snooze') reached.add(intent.pick);
    }
    expect([...reached]).toEqual([...SNOOZE_PICK_IDS]);
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
