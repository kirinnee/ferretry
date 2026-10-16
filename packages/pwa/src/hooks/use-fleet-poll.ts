/**
 * KEEPS ONE MACHINE'S SESSION LIST FRESH WHILE THE SESSIONS BAR SHOWS IT.
 *
 * The sessions bar is on every machine page, so its status dots and "needs you" badges must move
 * without the reader visiting the dashboard. One list read on mount, then one every
 * {@link FLEET_POLL_MS} while the tab is visible — a hidden tab reads nothing, and becoming visible
 * again reads at once rather than waiting out the interval. The fleet store already coalesces
 * concurrent reads of the same machine, so the dashboard's own read and this one share a request.
 *
 * KEYED ON THE PAIRING, NOT ON THE CONNECTION OBJECT. A daemon routinely republishes the carriers it
 * can be reached on right after its first answer, which hands the app a NEW connection object for the
 * same machine, address and grant. Re-reading the list on that would replace an open session's rows
 * mid-mount for nothing; the next tick reads through whichever object is current anyway.
 */

import { useEffect, useRef } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';

export const FLEET_POLL_MS = 15_000;

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

export function useFleetPoll(
  fleet: Pick<DaemonFleetStore, 'hydrate'>,
  connection: DaemonConnection,
  environment: FleetPollEnvironment = browserFleetPollEnvironment,
): void {
  const current = useRef(connection);
  current.current = connection;
  const { daemonId, baseUrl, deviceId } = connection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing's three facts are the deliberate key
  useEffect(() => {
    // A failed read is the slice's own error state; the bar keeps the rows it already had.
    const read = (): void => {
      if (environment.visible()) void fleet.hydrate(current.current).catch(() => undefined);
    };
    read();
    const handle = environment.setInterval(read, FLEET_POLL_MS);
    const release = environment.onVisibility(read);
    return () => {
      environment.clearInterval(handle);
      release();
    };
  }, [daemonId, baseUrl, deviceId, environment, fleet]);
}
