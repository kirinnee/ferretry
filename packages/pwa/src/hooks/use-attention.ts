import type { AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DaemonAttentionClient } from '../lib/attention-client.ts';
import type { AttentionLoadStatus } from '../lib/attention-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';

/** Hydrates the complete attention ledger for exactly one paired daemon and session. */
export const useAttentionSession = (
  client: DaemonAttentionClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
): AttentionLoadStatus => {
  useEffect(() => {
    if (scope !== null) void client.hydrate(connection, scope).catch(() => {});
  }, [client, connection, scope]);
  return useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => (scope === null ? 'idle' : client.store.status(scope)),
    () => 'idle',
  );
};

export const useAttentionSnapshot = (
  client: DaemonAttentionClient,
  scope: DaemonSessionScope | null,
): AttentionSnapshot | null => {
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  const key = scope === null ? null : daemonSessionKey(scope);
  return useMemo(() => (key === null ? null : (store.snapshots.get(key) ?? null)), [key, store]);
};

export const useAttentionItems = (
  client: DaemonAttentionClient,
  scope: DaemonSessionScope | null,
): AttentionSnapshot['items'] => useAttentionSnapshot(client, scope)?.items ?? [];

export const useAttentionResolutions = (
  client: DaemonAttentionClient,
  scope: DaemonSessionScope | null,
): ResolvedAttentionItem[] => useAttentionSnapshot(client, scope)?.resolved ?? [];

/** Badge-only path: asks for a count without marking a complete board as hydrated. */
export const useAttentionCount = (
  client: DaemonAttentionClient,
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
