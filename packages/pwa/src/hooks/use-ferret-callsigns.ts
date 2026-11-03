import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { AppStore } from '../lib/store.tsx';

const NO_CALLSIGNS: ReadonlyMap<string, string> = new Map();
const NO_FLEET = () => undefined;

/** Every ferret's callsign by session id, from the sessions every paired machine reports; empty without a store. */
export function useFerretCallsigns(store: AppStore | null): ReadonlyMap<string, string> {
  const subscribe = useCallback(
    (listener: () => void) => (store === null ? NO_FLEET : store.fleet.subscribe(listener)),
    [store],
  );
  const fleet = useSyncExternalStore(subscribe, () => store?.fleet.getSnapshot() ?? null);
  return useMemo(() => {
    if (fleet === null) return NO_CALLSIGNS;
    const names = new Map<string, string>();
    for (const slice of fleet.daemons.values()) {
      for (const session of slice.sessions ?? []) {
        if (session.config.teammate !== undefined) names.set(session.config.id, session.config.teammate);
      }
    }
    return names;
  }, [fleet]);
}
