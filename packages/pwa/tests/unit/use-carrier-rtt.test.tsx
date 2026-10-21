/** The live carrier's round trip, polled only for WebRTC and only while it is on screen (§16). */

import { describe, it } from 'bun:test';
import type { ConnectionChoice } from '@ferretry/relay';
import should from 'should';
import { CARRIER_RTT_POLL_MS, type CarrierRttClock, useCarrierRtt } from '../../src/hooks/use-carrier-rtt.ts';
import { render, run, runAsync } from '../support/react.ts';

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

describe('useCarrierRtt', () => {
  it('should measure a WebRTC carrier at once and on every tick, and stop when the panel goes', async () => {
    // Arrange
    const readings = [41, 37];
    const measure = async () => readings.shift();
    const { clock, fire, stopped, intervals } = manualClock();
    let seen: ConnectionChoice | undefined;
    const Probe = (): null => {
      seen = useCarrierRtt(WEBRTC, measure, clock);
      return null;
    };

    // Act
    const view = render(<Probe />);
    await runAsync(settle);
    const first = seen;
    await runAsync(async () => {
      fire();
      await settle();
    });
    const second = seen;
    run(() => view.unmount());

    // Assert
    should(first).match({ rttMs: 41 });
    should(second).match({ rttMs: 37 });
    should(intervals).deepEqual([CARRIER_RTT_POLL_MS]);
    should(stopped()).equal(1);
  });

  it.each<[string, ConnectionChoice | undefined, boolean]>([
    ['a relay carrier', RELAY, true],
    ['no carrier yet', undefined, true],
    ['a WebRTC carrier with nothing to ask', WEBRTC, false],
  ])('should poll nothing for %s and hand the choice back untouched', async (_name, choice, withMeasure) => {
    // Arrange
    let asked = 0;
    const measure = async () => {
      asked += 1;
      return 9;
    };
    const { clock, intervals } = manualClock();
    let seen: ConnectionChoice | undefined | 'unset' = 'unset';
    const Probe = (): null => {
      seen = useCarrierRtt(choice, withMeasure ? measure : undefined, clock);
      return null;
    };

    // Act
    const view = render(<Probe />);
    await runAsync(settle);
    run(() => view.unmount());

    // Assert
    should(seen).equal(choice);
    should(asked).equal(0);
    should(intervals).be.empty();
  });

  it('should keep the choice as it was when a measurement fails or has nothing, and ignore one that lands late', async () => {
    // Arrange
    let finish: (value: number) => void = () => undefined;
    const answers: Array<() => Promise<number | undefined>> = [
      async () => {
        throw new Error('stats unavailable');
      },
      async () => undefined,
      async () => await new Promise<number>(resolve => (finish = resolve)),
    ];
    const measure = async () => await (answers.shift() ?? (async () => undefined))();
    const { clock, fire } = manualClock();
    let seen: ConnectionChoice | undefined;
    const Probe = (): null => {
      seen = useCarrierRtt(WEBRTC, measure, clock);
      return null;
    };

    // Act
    const view = render(<Probe />);
    await runAsync(settle);
    const afterFailure = seen;
    await runAsync(async () => {
      fire();
      await settle();
    });
    const afterNothing = seen;
    await runAsync(async () => {
      fire();
      await settle();
    });
    run(() => view.unmount());
    finish(99);
    await settle();

    // Assert
    should(afterFailure).equal(WEBRTC);
    should(afterNothing).equal(WEBRTC);
  });

  it('should use the browser clock when none is given, and clear it on unmount', () => {
    // Arrange
    const Probe = (): null => {
      useCarrierRtt(WEBRTC, async () => 12);
      return null;
    };

    // Act + Assert — mounting starts the real interval and unmounting clears it, or this suite would hang.
    const view = render(<Probe />);
    run(() => view.unmount());
  });
});
