/**
 * The carrier a daemon's traffic is MEASURED to be on, as a React subscription.
 *
 * The answer changes when a request is carried, not when a component renders, so it
 * comes from the router's own store rather than from state a screen keeps. That is
 * also why `undefined` is a real value here: before the first request nothing has
 * been carried, and a hook that filled that in with "direct" would be reporting a
 * measurement nobody took — which is precisely the claim this unit replaced.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonCarrierRouter } from '../lib/relay-carrier.ts';

export function useActiveCarrier(router: DaemonCarrierRouter, daemonId: DaemonId): ConnectionChoice | undefined {
  const subscribe = useCallback((listener: () => void) => router.subscribe(listener), [router]);
  // Memoised against the router AND the daemon: `useSyncExternalStore` compares the
  // snapshot by identity, and `choice` returns the same stored object until the
  // router publishes a new one, so an unchanged carrier does not re-render.
  const snapshot = useCallback(() => router.choice(daemonId), [router, daemonId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Whether this daemon refused this browser's device (`4403`), as a React subscription.
 *
 * The same store as the carrier: the refusal is learned when a request is carried, so the screen that
 * says "pair again" appears the moment the first panel's request is refused, and goes when a re-pair
 * replaces the pairing.
 */
export function useDeviceRefused(router: DaemonCarrierRouter, daemonId: DaemonId): boolean {
  const subscribe = useCallback((listener: () => void) => router.subscribe(listener), [router]);
  const snapshot = useCallback(() => router.deviceRefused(daemonId), [router, daemonId]);
  return useSyncExternalStore(subscribe, snapshot);
}
