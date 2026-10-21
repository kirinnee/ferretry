/**
 * The live carrier's round trip, measured while somebody is looking at it (`docs/relay-protocol.md` §16).
 *
 * Only WebRTC measures one — the selected candidate pair's `currentRoundTripTime` — so the choice comes
 * back untouched for every other carrier, and nothing is polled. While a WebRTC choice is on screen the
 * path is asked every {@link CARRIER_RTT_POLL_MS}; the poll stops the moment the panel unmounts or the
 * carrier changes, because a measurement nobody reads is a timer that never should have run.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { useEffect, useMemo, useState } from 'react';

/** How often a WebRTC round trip on screen is measured again. */
export const CARRIER_RTT_POLL_MS = 5_000;

/** `setInterval`, injected so a suite needs no wall clock. */
export interface CarrierRttClock {
  readonly every: (tick: () => void, milliseconds: number) => () => void;
}

const browserClock: CarrierRttClock = {
  every: (tick, milliseconds) => {
    const handle = globalThis.setInterval(tick, milliseconds);
    return () => globalThis.clearInterval(handle);
  },
};

export function useCarrierRtt(
  choice: ConnectionChoice | undefined,
  measure: (() => Promise<number | undefined>) | undefined,
  clock: CarrierRttClock = browserClock,
): ConnectionChoice | undefined {
  const [rttMs, setRttMs] = useState<number | undefined>(undefined);
  const peerToPeer = choice?.ok === true && choice.method.kind === 'webrtc';
  useEffect(() => {
    setRttMs(undefined);
    if (!peerToPeer || measure === undefined) return;
    let current = true;
    const read = (): void => {
      void measure().then(
        value => {
          if (current) setRttMs(value);
        },
        () => undefined,
      );
    };
    read();
    const stop = clock.every(read, CARRIER_RTT_POLL_MS);
    return () => {
      current = false;
      stop();
    };
  }, [peerToPeer, measure, clock]);
  return useMemo(
    () => (choice?.ok === true && peerToPeer && rttMs !== undefined ? { ...choice, rttMs } : choice),
    [choice, peerToPeer, rttMs],
  );
}
