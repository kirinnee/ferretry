import type { Pin, PinSnapshot } from '@ferretry/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import {
  clearForegroundPinScope,
  getForegroundPinScope,
  setForegroundPinScope,
  subscribeForegroundPinScope,
} from '../lib/pin-bridge.ts';
import type { DaemonPinClient } from '../lib/pin-client.ts';
import type { PinLoadStatus } from '../lib/pin-store.ts';

/** Hydrates and subscribes to one exact daemon/session pin board. */
export const usePinsSession = (
  client: DaemonPinClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
): PinLoadStatus => {
  useEffect(() => {
    if (scope !== null) void client.hydrate(connection, scope).catch(() => {});
  }, [client, connection, scope]);
  return useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => (scope === null ? 'idle' : client.store.status(scope)),
    () => 'idle',
  );
};

/** Returns only the currently scoped board; equal session ids from other daemons cannot appear here. */
export const useSessionPins = (client: DaemonPinClient, scope: DaemonSessionScope | null): PinSnapshot | null => {
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  const key = scope === null ? null : daemonSessionKey(scope);
  return useMemo(() => (key === null ? null : (store.snapshots.get(key) ?? null)), [key, store]);
};

/** The compact trigger count also starts the scoped pin hydration. */
export const usePinCount = (
  client: DaemonPinClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
): number => {
  usePinsSession(client, connection, scope);
  return useSessionPins(client, scope)?.pins.length ?? 0;
};

export const useMessagePinned = (
  client: DaemonPinClient,
  scope: DaemonSessionScope | null,
  blockId: string,
): boolean => {
  const board = useSessionPins(client, scope);
  return useMemo(
    () => board?.pins.some((pin: Pin) => pin.kind === 'message' && pin.blockId === blockId) ?? false,
    [blockId, board],
  );
};

/** Complete foreground identity, never a session-id-only singleton. */
export const useForegroundPinScope = (): DaemonSessionScope | null =>
  useSyncExternalStore(subscribeForegroundPinScope, getForegroundPinScope, () => null);

/** Active session headers declare their scope and cannot clear a newer foreground pane on teardown. */
export const useDeclareForegroundPinScope = (scope: DaemonSessionScope, active: boolean): void => {
  useEffect(() => {
    if (!active) return undefined;
    setForegroundPinScope(scope);
    return () => clearForegroundPinScope(scope);
  }, [active, scope]);
};
