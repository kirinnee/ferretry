import type { AgendaListSnapshot } from '@ferretry/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DaemonAgendaClient } from '../lib/agenda-client.ts';
import type { AgendaLoadStatus } from '../lib/agenda-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';

/** Hydrates the complete agenda ledger for exactly one paired daemon and session. */
export const useAgendaSession = (
  client: Pick<DaemonAgendaClient, 'hydrate' | 'store'>,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
): AgendaLoadStatus => {
  useEffect(() => {
    if (scope !== null) void client.hydrate(connection, scope).catch(() => {});
  }, [client, connection, scope]);
  return useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => (scope === null ? 'idle' : client.store.status(scope)),
    () => 'idle',
  );
};

export const useAgendaSnapshot = (
  client: Pick<DaemonAgendaClient, 'store'>,
  scope: DaemonSessionScope | null,
): AgendaListSnapshot | null => {
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  const key = scope === null ? null : daemonSessionKey(scope);
  return useMemo(() => (key === null ? null : (store.snapshots.get(key) ?? null)), [key, store]);
};
