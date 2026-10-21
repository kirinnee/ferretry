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
import type { TunnelServiceState } from '../lib/tunnel-service.ts';

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
