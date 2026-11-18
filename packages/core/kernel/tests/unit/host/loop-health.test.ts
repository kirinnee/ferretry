/** The event-loop lag meter, the disk-pressure reading and the watchdog's decisions (J-0039 J-0085 are proved by `loop-health-host.test.ts`). */
import { describe, expect, test } from 'bun:test';
import {
  classifyStallCause,
  createLoopMeter,
  DEFAULT_WATCHDOG_LIMIT_MS,
  describeLoopStall,
  describeWatchdogFire,
  type IoPressure,
  ioPressureView,
  parseIoPressure,
  parseWatchdogLimit,
  watchdogShouldFire,
  watchdogSilenceFrom,
} from '../../../host/loop-health.ts';

const PSI = 'some avg10=0.50 avg60=1.00 avg300=2.00 total=123456\nfull avg10=0.25 avg60=0.50 avg300=1.00 total=4567\n';

/** A clock the test moves by hand: the meter reads it, `jump` moves it. */
function hand(start = 1_000): { now: () => number; jump: (ms: number) => void } {
  let at = start;
  return { now: () => at, jump: ms => (at += ms) };
}

describe('the disk-pressure reading', () => {
  test('parses a some and a full line, and a some line alone', () => {
    expect(parseIoPressure(PSI)).toEqual({
      some: { avg10: 0.5, avg60: 1, avg300: 2 },
      full: { avg10: 0.25, avg60: 0.5, avg300: 1 },
    });
    expect(parseIoPressure('some avg10=1.00 avg60=2.00 avg300=3.00 total=9\n')).toEqual({
      some: { avg10: 1, avg60: 2, avg300: 3 },
    });
  });

  test('is no reading when the text is empty, garbled, has no some line or a share out of range', () => {
    expect(parseIoPressure('')).toBeUndefined();
    expect(parseIoPressure('not pressure at all')).toBeUndefined();
    expect(parseIoPressure('full avg10=1.00 avg60=1.00 avg300=1.00 total=1\n')).toBeUndefined();
    expect(parseIoPressure('some avg10=101.00 avg60=1.00 avg300=1.00 total=1\n')).toBeUndefined();
    expect(parseIoPressure('some avg10=1.00 total=1\n')).toBeUndefined();
  });

  test('calls the disk saturated by full at 10, by some at 25, and never without a reading', () => {
    const line = (avg10: number) => ({ avg10, avg60: 0, avg300: 0 });
    expect(classifyStallCause(undefined)).toBeUndefined();
    expect(classifyStallCause({ some: line(24.9) })).toBeUndefined();
    expect(classifyStallCause({ some: line(25) })).toBe('disk');
    expect(classifyStallCause({ some: line(1), full: line(9.9) })).toBeUndefined();
    expect(classifyStallCause({ some: line(1), full: line(10) })).toBe('disk');
  });

  test('is told as the last-10-second shares and the verdict, never the raw windows', () => {
    const reading = parseIoPressure(PSI) as IoPressure;
    expect(ioPressureView(reading)).toEqual({ someAvg10: 0.5, fullAvg10: 0.25, saturated: false });
    expect(ioPressureView({ some: { avg10: 30, avg60: 1, avg300: 1 } })).toEqual({ someAvg10: 30, saturated: true });
  });
});

describe('the event-loop lag meter', () => {
  test('an on-time tick has no lag and no stall', () => {
    const clock = hand();
    const meter = createLoopMeter({ nowMs: clock.now });
    clock.jump(250);
    meter.tick();
    expect(meter.view()).toEqual({ lagMs: 0, maxLagMs: 0, stalls: 0 });
    expect(meter.blockedMs()).toBe(0);
  });

  test('a late tick is lag; one past the stall bar is a stall, kept as the last and the worst', () => {
    const clock = hand();
    const told: number[] = [];
    const meter = createLoopMeter({ nowMs: clock.now, onStall: stall => told.push(stall.durationMs) });
    clock.jump(250 + 100);
    meter.tick();
    expect(meter.view()).toEqual({ lagMs: 100, maxLagMs: 100, stalls: 0 });
    clock.jump(250 + 900);
    meter.tick();
    clock.jump(250 + 300);
    meter.tick();
    const view = meter.view();
    expect(told).toEqual([900, 300]);
    expect([view.lagMs, view.maxLagMs, view.stalls]).toEqual([300, 900, 2]);
    expect(view.lastStall?.durationMs).toBe(300);
    expect(view.worstStall?.durationMs).toBe(900);
    expect(view.lastStall).toMatchObject({ during: [], innermost: [], stacks: [] });
    expect(String(view.worstStall?.at)).toBe(new Date(1_000 + 350 + 1_150).toISOString());
  });

  test('the blocked total counts a late tick that has not fired yet, and never goes down', () => {
    const clock = hand();
    const meter = createLoopMeter({ nowMs: clock.now });
    clock.jump(250 + 400);
    expect(meter.blockedMs()).toBe(400);
    meter.tick();
    expect(meter.blockedMs()).toBe(400);
    clock.jump(250);
    meter.tick();
    expect(meter.blockedMs()).toBe(400);
  });

  test('says the disk when a stall lands while the disk is saturated, with the reading beside it', () => {
    const clock = hand();
    const reading: IoPressure = { some: { avg10: 40, avg60: 1, avg300: 1 } };
    const meter = createLoopMeter({ nowMs: clock.now, io: () => reading });
    clock.jump(250 + 600);
    meter.tick();
    const view = meter.view();
    expect(view.io).toEqual({ someAvg10: 40, saturated: true });
    expect(view.lastStall).toMatchObject({ cause: 'disk', io: { someAvg10: 40, saturated: true } });
    expect(describeLoopStall(view.lastStall as never)).toBe(
      'event loop stalled for 0.6s — the disk is saturated, so the daemon is slow, not dead',
    );
  });

  test('a stall with no reading says no cause, and the view has no io', () => {
    const clock = hand();
    const meter = createLoopMeter({ nowMs: clock.now, io: () => undefined, intervalMs: 100, stallMs: 50 });
    clock.jump(100 + 50);
    meter.tick();
    const stall = meter.view().lastStall;
    expect(stall).not.toHaveProperty('cause');
    expect(stall).not.toHaveProperty('io');
    expect(meter.view()).not.toHaveProperty('io');
    expect(describeLoopStall(stall as never)).toBe('event loop stalled for 0.1s');
  });
});

describe('the event-loop lag meter, observed', () => {
  test('every tick is heard with its lateness and time, also the ones too short to be a stall', () => {
    const clock = hand();
    const meter = createLoopMeter({ nowMs: clock.now });
    const heard: [number, number][] = [];
    meter.observe((lagMs, atMs) => heard.push([lagMs, atMs]));
    clock.jump(250);
    meter.tick();
    clock.jump(250 + 40);
    meter.tick();
    expect(heard).toEqual([
      [0, 1_250],
      [40, 1_540],
    ]);
  });

  test('a stopped observer hears nothing more, and the others still do', () => {
    const clock = hand();
    const meter = createLoopMeter({ nowMs: clock.now });
    const first: number[] = [];
    const second: number[] = [];
    const stop = meter.observe(lag => first.push(lag));
    meter.observe(lag => second.push(lag));
    clock.jump(250);
    meter.tick();
    stop();
    clock.jump(250 + 10);
    meter.tick();
    expect(first).toEqual([0]);
    expect(second).toEqual([0, 10]);
  });

  test('a stall carries the labels of the work in flight, read only for the stall, and the log line names them', () => {
    const clock = hand();
    let asked = 0;
    const meter = createLoopMeter({
      nowMs: clock.now,
      during: () => {
        asked += 1;
        return ['usage/usage-budget', 'ferrets/ferrets-health'];
      },
    });
    clock.jump(250 + 10);
    meter.tick();
    expect(asked).toBe(0);
    clock.jump(250 + 1_500);
    meter.tick();
    const stall = meter.view().lastStall;
    expect(stall).toMatchObject({
      during: ['usage/usage-budget', 'ferrets/ferrets-health'],
      innermost: ['usage/usage-budget', 'ferrets/ferrets-health'],
    });
    expect(describeLoopStall(stall as never)).toBe(
      'event loop stalled for 1.5s (during usage/usage-budget, ferrets/ferrets-health)',
    );
  });
});

describe('the watchdog', () => {
  test('fires at the limit, never below it, and never when the limit is 0', () => {
    expect(watchdogShouldFire(299_999, 300_000)).toBe(false);
    expect(watchdogShouldFire(300_000, 300_000)).toBe(true);
    expect(watchdogShouldFire(10 ** 9, 0)).toBe(false);
  });

  test('measures the silence from the last beat, or from now after the whole process was suspended', () => {
    // A normal check: the beat is the silence's start (and a later beat wins over an earlier start).
    expect(watchdogSilenceFrom(5_000, 6_000, 5_000, 0, 1_000)).toBe(5_000);
    expect(watchdogSilenceFrom(5_000, 6_000, 5_000, 5_500, 1_000)).toBe(5_500);
    // A check that arrives an hour after the previous one means nothing ran: start again from now.
    expect(watchdogSilenceFrom(5_000, 3_605_000, 5_000, 0, 1_000)).toBe(3_605_000);
  });

  test('names what was running, or says nothing named was', () => {
    expect(describeWatchdogFire(301_000, 'boot: state')).toBe(
      'watchdog: the event loop has not run for 301s (during boot: state) — ending this process so its service manager starts a fresh one',
    );
    expect(describeWatchdogFire(300_000, '')).toContain('(no named work was in flight)');
  });

  test('its limit is five minutes by default, 0 turns it off, and anything but whole seconds is refused by name', () => {
    expect(parseWatchdogLimit(undefined)).toBe(DEFAULT_WATCHDOG_LIMIT_MS);
    expect(parseWatchdogLimit('  ')).toBe(DEFAULT_WATCHDOG_LIMIT_MS);
    expect(parseWatchdogLimit('0')).toBe(0);
    expect(parseWatchdogLimit(' 90 ')).toBe(90_000);
    expect(() => parseWatchdogLimit('5m')).toThrow('FYD_WATCHDOG_SECONDS must be a whole number of seconds: 5m');
  });
});
