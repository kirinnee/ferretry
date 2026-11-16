import { describe, expect, test } from 'bun:test';
import {
  HIGH_PUSHES_PER_FERRET_PER_HOUR,
  HIGH_PUSHES_PER_HOUR,
  HighPushCap,
} from '../../../../daemon/lib/push/index.ts';

const HOUR = 3_600_000;

function world() {
  const clock = { at: Date.parse('2026-11-10T09:00:00.000Z') };
  const cap = new HighPushCap({ nowMs: () => clock.at });
  /** Whether each of `count` takes by `ferret` kept high priority. */
  const takes = (count: number, ferret?: string): boolean[] =>
    Array.from({ length: count }, () => cap.take(ferret).high);
  return { clock, cap, takes };
}

describe('the hourly cap on high-priority pushes', () => {
  test('the limits are three an hour per ferret and twelve across the daemon', () => {
    expect(HIGH_PUSHES_PER_FERRET_PER_HOUR).toBe(3);
    expect(HIGH_PUSHES_PER_HOUR).toBe(12);
  });

  test('B1 the 4th high push in an hour from one ferret goes at normal priority', () => {
    const w = world();
    expect(w.takes(4, 'ferret-a')).toEqual([true, true, true, false]);
    // Another ferret still has its own three.
    expect(w.takes(3, 'ferret-b')).toEqual([true, true, true]);
  });

  test('B1 the 13th high push across ferrets in an hour goes at normal priority', () => {
    const w = world();
    // Four ferrets spend their own three each: twelve in all, every one high.
    const first = ['a', 'b', 'c', 'd'].flatMap(ferret => w.takes(3, ferret));
    expect(first).toEqual(Array.from({ length: 12 }, () => true));
    // A fifth ferret has spent nothing, and still goes at normal priority: the daemon's twelve are gone.
    expect(w.cap.take('e').high).toBe(false);
  });

  test('B1 a high push with no ferret counts against the daemon cap only', () => {
    const w = world();
    expect(w.takes(12)).toEqual(Array.from({ length: 12 }, () => true));
    expect(w.cap.take().high).toBe(false);
  });

  test('B1 an hour later the cap resets', () => {
    const w = world();
    expect(w.takes(4, 'ferret-a')).toEqual([true, true, true, false]);
    w.clock.at += HOUR - 1;
    expect(w.cap.take('ferret-a').high).toBe(false);
    w.clock.at += 2;
    expect(w.takes(4, 'ferret-a')).toEqual([true, true, true, false]);
  });

  test('B1 a push that reached no one is refunded, and a refund is given back once', () => {
    const w = world();
    const slots = [w.cap.take('ferret-a'), w.cap.take('ferret-a'), w.cap.take('ferret-a')];
    expect(w.cap.take('ferret-a').high).toBe(false);
    // The second reached no device: its slot is given back, and only once however often it is asked.
    slots[1]?.refund();
    slots[1]?.refund();
    expect(w.takes(2, 'ferret-a')).toEqual([true, false]);
  });

  test('B1 a refund also frees the daemon-wide slot', () => {
    const w = world();
    const slots = Array.from({ length: 12 }, (_, index) => w.cap.take(`ferret-${index}`));
    expect(w.cap.take('ferret-x').high).toBe(false);
    slots[5]?.refund();
    expect(w.cap.take('ferret-y').high).toBe(true);
  });

  test('B1 a push past a cap holds no slot to refund', () => {
    const w = world();
    w.takes(3, 'ferret-a');
    const over = w.cap.take('ferret-a');
    expect(over.high).toBe(false);
    over.refund();
    expect(w.cap.take('ferret-a').high).toBe(false);
  });
});
