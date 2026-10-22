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
 *   - A machine whose FLEET FEED is live (`lib/fleet-feed.ts`) is read when its feed says something
 *     moved, and on these beats only as a safety net, every {@link FLEET_FEED_SAFETY_MS}. A daemon too
 *     old for the feed keeps the beats above.
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

import type { FyEvent } from '@ferretry/protocol';
import { useEffect, useRef } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import {
  browserFleetFeedEnvironment,
  type FleetFeedEnvironment,
  type FleetFeedStatus,
  startFleetFeed,
} from '../lib/fleet-feed.ts';
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
  /** The clock a live feed's safety net is measured on; `Date.now` when absent. */
  readonly now?: () => number;
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

/**
 * While a machine's fleet feed is live, its list is read when the feed says something moved, and on
 * the beats above only once this long has passed since the last read: a safety net for what a feed
 * cannot say, never the way a change is learned.
 */
export const FLEET_FEED_SAFETY_MS = 5 * 60_000;

/** Opens one machine's fleet feed (`fleet-feed.ts`): the app's client pool, `tail=0`. */
export type MachineFleetFeedOpener = (
  machine: DaemonConnection,
  onEvent: (event: FyEvent) => void,
  onIdle: (idleSeconds: number) => void,
  signal: AbortSignal,
) => Promise<void>;

export function useMachinesPoll(
  fleet: Pick<DaemonFleetStore, 'hydrate'>,
  machines: readonly DaemonConnection[],
  /** The machine on screen, which keeps the quicker beat; `null` when no machine page is open. */
  current: DaemonId | null,
  phone: boolean,
  environment: FleetPollEnvironment = browserFleetPollEnvironment,
  /** Each machine's fleet feed; absent, the lists are polled as they always were. */
  openFleetFeed?: MachineFleetFeedOpener,
  feedEnvironment: FleetFeedEnvironment = browserFleetFeedEnvironment,
): void {
  const latest = useRef(machines);
  latest.current = machines;
  const key = pairingKey(machines);
  /** Each machine's feed, as it last said, and when its list was last read: shared by both effects. */
  const feeds = useRef(new Map<DaemonId, FleetFeedStatus>());
  const lastRead = useRef(new Map<DaemonId, number>());
  const now = environment.now ?? Date.now;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    // A failed read is that machine's slice error; the list keeps the rows it already had.
    const read = (which: 'current' | 'background' | 'all'): void => {
      if (!environment.visible()) return;
      for (const machine of latest.current) {
        const onScreen = machine.daemonId === current;
        if (which !== 'all' && (which === 'current') !== onScreen) continue;
        // A live feed says when this list moves; the beat only covers what a feed cannot say.
        const quiet = now() - (lastRead.current.get(machine.daemonId) ?? Number.NEGATIVE_INFINITY);
        if (which !== 'all' && feeds.current.get(machine.daemonId) === 'live' && quiet < FLEET_FEED_SAFETY_MS) continue;
        lastRead.current.set(machine.daemonId, now());
        void fleet.hydrate(machine).catch(() => undefined);
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

  // One feed per paired machine, kept across navigation: only a change of pairings reopens them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    if (openFleetFeed === undefined) return;
    const statuses = feeds.current;
    const controls = latest.current.map(paired =>
      startFleetFeed({
        // Through whichever connection object is current for this pairing when it (re)opens.
        open: async (onEvent, onIdle, signal) =>
          await openFleetFeed(
            latest.current.find(machine => machine.daemonId === paired.daemonId) ?? paired,
            onEvent,
            onIdle,
            signal,
          ),
        onChange: () => {
          // A hidden app reads nothing; showing it reads every machine anyway.
          if (!environment.visible()) return;
          const machine = latest.current.find(candidate => candidate.daemonId === paired.daemonId);
          if (machine === undefined) return;
          lastRead.current.set(machine.daemonId, now());
          void fleet.hydrate(machine).catch(() => undefined);
        },
        onStatus: status => statuses.set(paired.daemonId, status),
        environment: feedEnvironment,
      }),
    );
    return () => {
      for (const control of controls) control.stop();
      statuses.clear();
    };
  }, [key, openFleetFeed, feedEnvironment, environment, fleet]);
}
