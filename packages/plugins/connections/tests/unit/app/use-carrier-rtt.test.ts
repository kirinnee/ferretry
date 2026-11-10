/**
 * R686: the live carrier's round trip, polled only for WebRTC and only while it is on screen (§16). Ported from v4's
 * `pwa/tests/unit/use-carrier-rtt.test.tsx`, plus the Connection panel that reads it.
 */
import { describe, expect, test } from 'bun:test';
import { render, run, runAsync } from '@ferretry/app/testing';
import { createElement } from 'react';
import { CARRIER_RTT_POLL_MS, type CarrierRttClock, useCarrierRtt } from '../../../app/lib/use-carrier-rtt.ts';
import { type ConnectionChoice } from '../../../app/lib/connection.ts';

const WEBRTC: ConnectionChoice = {
  ok: true,
  method: { kind: 'webrtc' },
  reason: 'Connected over WebRTC.',
  passedOver: [],
};
const RELAY: ConnectionChoice = {
  ok: true,
  method: { kind: 'relay', relayUrl: 'https://relay.example' },
  reason: 'Connected via relay.',
  passedOver: [],
};

/** A clock whose interval fires only when a case says so, and which records being stopped. */
const manualClock = () => {
  const ticks: Array<() => void> = [];
  let stopped = 0;
  const intervals: number[] = [];
  const clock: CarrierRttClock = {
    every: (tick, milliseconds) => {
      ticks.push(tick);
      intervals.push(milliseconds);
      return () => {
        stopped += 1;
      };
    },
  };
  return { clock, fire: () => ticks.at(-1)?.(), stopped: () => stopped, intervals };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

/** Mounts the hook on `choice` and hands back what it returned most recently. */
function probe(
  choice: ConnectionChoice | undefined,
  measure: (() => Promise<number | undefined>) | undefined,
  clock?: CarrierRttClock,
) {
  const seen: { value: ConnectionChoice | undefined | 'unset' } = { value: 'unset' };
  const Probe = (): null => {
    seen.value = useCarrierRtt(choice, measure, clock);
    return null;
  };
  return { seen, view: render(createElement(Probe)) };
}

describe('useCarrierRtt', () => {
  test('R686 a WebRTC carrier is measured at once and on every tick, and stops when the panel goes', async () => {
    const readings = [41, 37];
    const { clock, fire, stopped, intervals } = manualClock();
    const mounted = probe(WEBRTC, async () => readings.shift(), clock);
    await runAsync(settle);
    const first = mounted.seen.value;
    await runAsync(async () => {
      fire();
      await settle();
    });
    const second = mounted.seen.value;
    run(() => mounted.view.unmount());

    expect(first).toMatchObject({ rttMs: 41 });
    expect(second).toMatchObject({ rttMs: 37 });
    expect(intervals).toEqual([CARRIER_RTT_POLL_MS]);
    expect(stopped()).toBe(1);
  });

  test.each<[string, ConnectionChoice | undefined, boolean]>([
    ['a relay carrier', RELAY, true],
    ['no carrier yet', undefined, true],
    ['a WebRTC carrier with nothing to ask', WEBRTC, false],
  ])('R686 nothing is polled for %s and the choice comes back untouched', async (_name, choice, withMeasure) => {
    let asked = 0;
    const { clock, intervals } = manualClock();
    const mounted = probe(
      choice,
      withMeasure
        ? async () => {
            asked += 1;
            return 9;
          }
        : undefined,
      clock,
    );
    await runAsync(settle);
    run(() => mounted.view.unmount());

    expect(mounted.seen.value).toBe(choice);
    expect(asked).toBe(0);
    expect(intervals).toEqual([]);
  });

  test('R686 a measurement that fails or has nothing keeps the choice as it was, and one that lands late is ignored', async () => {
    let finish: (value: number) => void = () => undefined;
    const answers: Array<() => Promise<number | undefined>> = [
      async () => {
        throw new Error('stats unavailable');
      },
      async () => undefined,
      async () => await new Promise<number>(resolve => (finish = resolve)),
    ];
    const { clock, fire } = manualClock();
    const mounted = probe(WEBRTC, async () => await (answers.shift() ?? (async () => undefined))(), clock);
    await runAsync(settle);
    const afterFailure = mounted.seen.value;
    await runAsync(async () => {
      fire();
      await settle();
    });
    const afterNothing = mounted.seen.value;
    await runAsync(async () => {
      fire();
      await settle();
    });
    run(() => mounted.view.unmount());
    finish(99);
    await settle();

    expect(afterFailure).toBe(WEBRTC);
    expect(afterNothing).toBe(WEBRTC);
    expect(mounted.seen.value).toBe(WEBRTC);
  });

  test('R686 the browser clock is used when none is given, and is cleared on unmount', () => {
    // Mounting starts the real interval and unmounting clears it, or this suite would hang.
    const mounted = probe(WEBRTC, async () => 12);
    run(() => mounted.view.unmount());
    expect(mounted.seen.value).toBe(WEBRTC);
  });
});
