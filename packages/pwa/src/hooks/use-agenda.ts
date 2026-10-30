import type { AgendaSnapshot, ResolvedAgendaItem } from '@ferretry/protocol';
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
): AgendaSnapshot | null => {
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  const key = scope === null ? null : daemonSessionKey(scope);
  return useMemo(() => (key === null ? null : (store.snapshots.get(key) ?? null)), [key, store]);
};

export const useAgendaItems = (client: DaemonAgendaClient, scope: DaemonSessionScope | null): AgendaSnapshot['items'] =>
  useAgendaSnapshot(client, scope)?.items ?? [];

export const useAgendaResolutions = (
  client: DaemonAgendaClient,
  scope: DaemonSessionScope | null,
): ResolvedAgendaItem[] => useAgendaSnapshot(client, scope)?.resolved ?? [];

/** Badge-only path: asks for a count without marking a complete board as hydrated. */
export const useAgendaCount = (
  client: DaemonAgendaClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
): number => {
  useEffect(() => {
    if (scope !== null) void client.hydrateCount(connection, scope).catch(() => {});
  }, [client, connection, scope]);
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  return scope === null ? 0 : (store.counts.get(daemonSessionKey(scope)) ?? 0);
};
