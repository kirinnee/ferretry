import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useOptionalDevice } from './device-context.tsx';
import { usePluginIdentity } from './plugin-identity.tsx';

/**
 * THE LATEST ARRIVAL OF A DECLARED FRAGMENT THIS VIEW MAY TAKE (shell contract S3, MA3). `arrival` counts arrivals
 * (0 = none yet) and re-renders the caller on each new one; `take()` answers the held fragment ONCE, exactly as it
 * arrived (`#` included, so the plugin's own parser reads it unchanged), and empties the slot. The shell already took
 * it off the address bar and the history entry. The value is never handed as a render value: read it in an effect.
 *
 * Keyed (`key` is the declared key): answers only in the declaring plugin's device view. Path (`key` is the screen's
 * id): only on that declaring daemon-less screen. Anywhere else: `{ arrival: 0, take: () => undefined }`.
 */
export interface FragmentArrival {
  readonly arrival: number;
  readonly take: () => string | undefined;
}

const noSubscription = (): (() => void) => () => {};
const NOTHING: FragmentArrival = Object.freeze({ arrival: 0, take: () => undefined });

export function useFragment(key: string): FragmentArrival {
  const identity = usePluginIdentity();
  const address = useOptionalDevice()?.address;
  const slot = identity === null || address === undefined ? undefined : address.slotFor(identity, key);
  const arrival = useSyncExternalStore(
    slot === undefined ? noSubscription : (address?.subscribe ?? noSubscription),
    () => (slot === undefined ? 0 : (address?.arrival(slot) ?? 0)),
  );
  const take = useCallback(() => (slot === undefined ? undefined : address?.take(slot)), [address, slot]);
  return useMemo(() => (slot === undefined ? NOTHING : { arrival, take }), [arrival, slot, take]);
}
