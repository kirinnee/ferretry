/**
 * KEEPS EVERY PAIRED MACHINE'S SESSION LIST FRESH, cheaply, for the all-machines list.
 *
 * One lightweight read per machine — the same coalesced `fleet.hydrate` the sessions bar has always
 * made, through that machine's own pairing, so each list is fetched with that machine's own device key
 * and nothing else. No transcript, terminal or browser stream is opened here: those stay with the one
 * session on screen.
 *
 * THE CADENCE SPENDS WHERE THE READER IS LOOKING.
 *   - The machine on screen: every {@link FLEET_POLL_MS}, as before.
 *   - Every other machine: every {@link BACKGROUND_POLL_MS} on a desktop and every
 *     {@link PHONE_BACKGROUND_POLL_MS} on a phone, where each wake-up costs battery.
 *   - A hidden app reads NOTHING, on any machine, and coming back reads them all at once rather than
 *     waiting out an interval.
 *
 * With one machine — the Current machine only setting, or a browser paired to one — it is the poll the
 * sessions bar always ran: one read on mount and one per {@link FLEET_POLL_MS}. It is mounted by the
 * shell rather than by the bar, so a phone's Sessions page stays fresh with its drawer closed.
 *
 * KEYED ON THE PAIRINGS, NOT ON THE CONNECTION OBJECTS. A daemon routinely republishes the carriers it
 * can be reached on right after its first answer, which hands the app a NEW connection object for the
 * same machine, address and grant. Re-reading on that would replace an open session's rows mid-mount
 * for nothing; the next tick reads through whichever object is current anyway.
 */

import { useEffect, useRef } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
/** The machine on screen. */
export const FLEET_POLL_MS = 30_000;

/** A machine that is not on screen, on a desktop. */
export const BACKGROUND_POLL_MS = 120_000;

/** A machine that is not on screen, on a phone: a slower beat, because every wake-up costs battery. */
export const PHONE_BACKGROUND_POLL_MS = 300_000;

/** The interval for the machines that are not on screen. */
export const backgroundPollMs = (phone: boolean): number => (phone ? PHONE_BACKGROUND_POLL_MS : BACKGROUND_POLL_MS);

/** The browser seams the poll needs, injectable so the cadence is testable. */
export interface FleetPollEnvironment {
  readonly visible: () => boolean;
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly onVisibility: (callback: () => void) => () => void;
}

export const browserFleetPollEnvironment: FleetPollEnvironment = {
  visible: () => document.visibilityState !== 'hidden',
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  onVisibility: callback => {
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
};

/** The pairings' own facts, joined: the key a per-machine read restarts on, never a connection object. */
export const pairingKey = (machines: readonly DaemonConnection[]): string =>
  machines.map(machine => `${machine.daemonId}\u0000${machine.baseUrl}\u0000${machine.deviceId}`).join('\u0001');

export function useMachinesPoll(
  fleet: Pick<DaemonFleetStore, 'hydrate'>,
  machines: readonly DaemonConnection[],
  /** The machine on screen, which keeps the quicker beat; `null` when no machine page is open. */
  current: DaemonId | null,
  phone: boolean,
  environment: FleetPollEnvironment = browserFleetPollEnvironment,
): void {
  const latest = useRef(machines);
  latest.current = machines;
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    // A failed read is that machine's slice error; the list keeps the rows it already had.
    const read = (which: 'current' | 'background' | 'all'): void => {
      if (!environment.visible()) return;
      for (const machine of latest.current) {
        const onScreen = machine.daemonId === current;
        if (which === 'all' || (which === 'current') === onScreen) void fleet.hydrate(machine).catch(() => undefined);
      }
    };
    read('all');
    const foreground = environment.setInterval(() => read('current'), FLEET_POLL_MS);
    const background = environment.setInterval(() => read('background'), backgroundPollMs(phone));
    const release = environment.onVisibility(() => read('all'));
    return () => {
      environment.clearInterval(foreground);
      environment.clearInterval(background);
      release();
    };
  }, [key, current, phone, environment, fleet]);
}
