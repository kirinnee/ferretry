/**
 * This device's connection preferences, and whether the hosted tunnel service is set up, as React
 * subscriptions (`docs/relay-protocol.md` §15).
 *
 * The preference store is the one owner of the value; a selector only reads it here and writes it with
 * `set`, and the app store turns every write into a fresh carrier walk. The tunnel service is read at
 * most once per document — a selector mounting asks the same promise the router would.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CarrierPreferenceStore, CarrierPreferences } from '../lib/carrier-preference.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { TunnelServiceState } from '../lib/tunnel-service.ts';
import type { TunnelSwitchState, TunnelSwitchStore } from '../lib/tunnel-switch.ts';

/** Every machine's preference on this device, re-rendering when any changes. */
export function useCarrierPreferences(store: CarrierPreferenceStore): CarrierPreferences {
  const subscribe = useCallback((listener: () => void) => store.subscribe(() => listener()), [store]);
  return useSyncExternalStore(subscribe, store.snapshot, store.snapshot);
}

/** The hosted tunnel service's answer, or `undefined` until it arrives. Never throws. */
export function useTunnelService(read: () => Promise<TunnelServiceState>): TunnelServiceState | undefined {
  const [state, setState] = useState<TunnelServiceState | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void read().then(answer => {
      if (current) setState(answer);
    });
    return () => {
      current = false;
    };
  }, [read]);
  return state;
}

/** States a tunnel stays in until somebody changes something: nothing to wait for. */
const SETTLED: ReadonlySet<string> = new Set(['off', 'unavailable', 'up']);

/** How often a machine whose tunnel is being set up is asked again, while something shows it. */
export const TUNNEL_SWITCH_POLL_MS = 3_000;

/**
 * Every listed machine's tunnel switch, asked when the list mounts and again every
 * {@link TUNNEL_SWITCH_POLL_MS} while one is provisioning or connecting — so a tunnel turned on from
 * here is seen arriving, and nothing is polled once every tunnel has settled.
 */
export function useTunnelSwitches(
  store: TunnelSwitchStore,
  daemons: readonly DaemonConnection[],
  pollMs = TUNNEL_SWITCH_POLL_MS,
): Readonly<Record<string, TunnelSwitchState>> {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const states = useSyncExternalStore(subscribe, store.snapshot, store.snapshot);
  // One identity per SET of machines, so a re-render with the same machines asks nothing again.
  const key = daemons.map(daemon => daemon.daemonId).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `daemons`' identity.
  useEffect(() => {
    for (const daemon of daemons) void store.refresh(daemon);
  }, [store, key]);
  const settling = daemons.filter(daemon => {
    const state = states[daemon.daemonId];
    return state?.kind === 'known' && state.view.enabled && !SETTLED.has(state.view.state);
  });
  const settlingKey = settling.map(daemon => daemon.daemonId).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `settlingKey` is `settling`'s identity.
  useEffect(() => {
    if (settling.length === 0) return undefined;
    const timer = setInterval(() => {
      for (const daemon of settling) void store.refresh(daemon);
    }, pollMs);
    return () => clearInterval(timer);
  }, [store, settlingKey, pollMs]);
  return states;
}
