/**
 * S12, the shell's "forget this machine": the feed stores this device holds for a machine, so an unpaired machine's
 * cached usage is not left in this browser, and a later pairing that mints the same daemon id does not read it back.
 * The shell builds one half (and one feed store) per daemon, so the stores are held by the daemon they were built for.
 */
import { daemonOfClient } from '@ferretry/app';
import type { DaemonUsageStore } from './usage-store.ts';

const held = new Map<string, Set<DaemonUsageStore>>();

/** Holds a store built for `client`'s daemon until that daemon is forgotten. A client with no daemon is not held. */
export function holdUsageStore(client: object, store: DaemonUsageStore): void {
  const daemon = daemonOfClient(client);
  if (daemon === undefined) return;
  const stores = held.get(daemon) ?? new Set<DaemonUsageStore>();
  stores.add(store);
  held.set(daemon, stores);
}

/** Empties this machine's feed from every store built for it, and holds none of them any more. */
export function forgetUsageOf(daemon: string): void {
  for (const store of held.get(daemon) ?? []) store.clearDaemon(daemon);
  held.delete(daemon);
}
