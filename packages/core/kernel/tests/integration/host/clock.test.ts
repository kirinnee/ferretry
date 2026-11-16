/** The real clock reads real time and real timers; the copied clock runs on the functions it was handed. */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { copiedClock, systemClock } from '../../../host/adapters/clock.ts';

const sleepFor = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
};

describe('systemClock', () => {
  test('now and nowMs both read the wall clock', () => {
    const clock = systemClock();
    const before = Date.now();
    const ms = clock.nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(Date.parse(String(clock.now()))).toBeGreaterThanOrEqual(before);
  });

  test('after runs once, and the disarm it returns stops a pending one', async () => {
    const clock = systemClock();
    const ran: string[] = [];
    clock.after(milliseconds(5), () => ran.push('kept'));
    const cancel = clock.after(milliseconds(5), () => ran.push('cancelled'));
    cancel();
    await sleepFor(40);
    expect(ran).toEqual(['kept']);
  });

  test('every repeats until its disarm is called, and an interval below one millisecond is lifted to one', async () => {
    const clock = systemClock();
    let ticks = 0;
    const stop = clock.every(milliseconds(0), () => {
      ticks += 1;
    });
    await sleepFor(40);
    stop();
    const stopped = ticks;
    expect(stopped).toBeGreaterThanOrEqual(2);
    await sleepFor(30);
    expect(ticks).toBe(stopped);
  });

  test('sleep resolves after its delay', async () => {
    const clock = systemClock();
    const started = Date.now();
    await clock.sleep(milliseconds(20));
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test('sleep rejects with the signal reason at once when the signal was already aborted', async () => {
    const reason = new Error('already gone');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(systemClock().sleep(milliseconds(10_000), controller.signal)).rejects.toBe(reason);
  });

  test('sleep rejects with the signal reason when the signal aborts mid-sleep, and never resolves late', async () => {
    const reason = new Error('cancelled mid-sleep');
    const controller = new AbortController();
    const sleeping = systemClock().sleep(milliseconds(10_000), controller.signal);
    setTimeout(() => controller.abort(reason), 5);
    await expect(sleeping).rejects.toBe(reason);
  });
});

describe('copiedClock', () => {
  test('after arms the copied timer function and its disarm hands the same timer back to the copied clear', () => {
    const armed: { fn: () => void; delay: number }[] = [];
    const disarmed: unknown[] = [];
    const token = { timer: 1 };
    const clock = copiedClock(
      (fn, delay) => {
        armed.push({ fn, delay });
        return token;
      },
      timer => disarmed.push(timer),
      () => 1234,
    );
    expect(clock.nowMs()).toBe(1234);
    let fired = false;
    const disarm = clock.after(milliseconds(250), () => {
      fired = true;
    });
    expect(armed).toHaveLength(1);
    expect(armed[0]?.delay).toBe(250);
    armed[0]?.fn();
    expect(fired).toBe(true);
    disarm();
    expect(disarmed).toEqual([token]);
  });
});
