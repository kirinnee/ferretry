import type { AgendaListSnapshot } from '@ferretry/core-asks/contract';
import { useMemo, useSyncExternalStore } from 'react';
import type { DaemonAgendaClient } from '../lib/agenda-client.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../shell.ts';

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
