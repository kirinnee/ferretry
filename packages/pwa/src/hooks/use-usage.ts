/**
 * The daemon's cached account-usage feed, read from the store that polls it.
 *
 * Ported from kteam `ui/src/hooks/useUsage.ts`, which is deliberately 17 lines
 * long: the poll lives in the store (see `lib/usage-store.ts` for why), and a
 * hook that owned its own interval would restore the one-interval-per-consumer
 * bug that move existed to kill. This is a thin read of that slice with the
 * same guarantees — last-good on failure, an absent record is unknown rather
 * than 0%.
 *
 * The single-daemon assumption is gone. kteam's `useUsage()` took no argument
 * because there was one feed; here every read names the daemon it belongs to,
 * and switching connection cannot show the previous daemon's percentages.
 */

import type { SessionView } from '@ferretry/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonUsageSlice, DaemonUsageStore } from '../lib/usage-store.ts';
import type { ResolvedQuota } from '../lib/usage.ts';

/**
 * Subscribes to one paired daemon's feed for as long as the caller is mounted,
 * joining the store's shared poll rather than starting another one.
 */
export const useUsage = (store: DaemonUsageStore, daemon: DaemonConnection): DaemonUsageSlice => {
  useEffect(() => store.watch(daemon), [store, daemon]);
  return useSyncExternalStore(
    store.subscribe,
    () => store.usage(daemon.daemonId),
    () => store.usage(daemon.daemonId),
  );
};

/**
 * Reads a slice WITHOUT joining the poll — for chrome that renders whatever is
 * already known and must not make a fleet-wide request of its own.
 */
export const useUsageSlice = (store: DaemonUsageStore, daemonId: DaemonId): DaemonUsageSlice =>
  useSyncExternalStore(
    store.subscribe,
    () => store.usage(daemonId),
    () => store.usage(daemonId),
  );

/**
 * One session's quota, resolved from its own monitored state first and the
 * daemon's feed second. `null` means no data: a caller must render an explicit
 * unknown rather than zero percent.
 */
export const useSessionQuota = (
  store: DaemonUsageStore,
  daemonId: DaemonId,
  view: SessionView,
): ResolvedQuota | null => {
  useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  return store.quotaFor(daemonId, view);
};
