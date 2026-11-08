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

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DaemonConnection } from '../shell.ts';
import type { DaemonUsageSlice, DaemonUsageStore } from '../lib/usage-store.ts';

/** The machines' facts the join is keyed on: a change of machine set re-joins, a re-render of the same set does not. */
const pairingKey = (machines: readonly DaemonConnection[]): string =>
  machines.map(machine => machine.daemonId).join('\n');

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
 * Joins EVERY listed machine's feed — each through its own pairing, each in the store's shared,
 * refcounted poll — for the list across machines, whose full rows show each machine's own quota. The
 * reads are the resolver's: every one already names the machine (`quotaFor(daemonId, view)`).
 */
export const useMachinesUsage = (store: DaemonUsageStore, machines: readonly DaemonConnection[]): void => {
  const latest = useRef(machines);
  latest.current = machines;
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    const releases = latest.current.map(machine => store.watch(machine));
    return () => {
      for (const release of releases) release();
    };
  }, [store, key]);
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
