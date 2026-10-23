/**
 * The daemon on THIS computer, as a React subscription, and the one thing it is used for: handing a
 * link to the computer's own default browser (`POST /v1/system/open-url`).
 *
 * Outside an app store (a harness, a test) there is no daemon and the answer is `undefined`, so the
 * option is simply not offered.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useOptionalAppStore } from '../../lib/store.tsx';
import { type ComputerLinkPort, findLocalComputer } from './local-computer.ts';

export function useLocalComputer(): ComputerLinkPort | undefined {
  const store = useOptionalAppStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (store === null) return () => undefined;
      const stopConnections = store.connections.subscribe(listener);
      const stopCarrier = store.carrier.subscribe(listener);
      return () => {
        stopConnections();
        stopCarrier();
      };
    },
    [store],
  );
  // A string or null: `useSyncExternalStore` compares by identity, and a fresh object per read would loop.
  const daemonId = useSyncExternalStore(subscribe, () =>
    store === null
      ? null
      : (findLocalComputer(
          store.connections
            .list()
            .map(daemon => ({ daemonId: daemon.daemonId, choice: store.carrier.choice(daemon.daemonId) })),
        ) ?? null),
  );
  return useMemo<ComputerLinkPort | undefined>(() => {
    if (store === null || daemonId === null) return undefined;
    return async href => {
      const daemon = store.connections.list().find(record => record.daemonId === daemonId);
      if (daemon === undefined) throw new Error('the local daemon is no longer paired');
      await (await store.clients.client(daemon)).openUrl(href);
    };
  }, [store, daemonId]);
}
