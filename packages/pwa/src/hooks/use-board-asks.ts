/** The agendas a card's asks live in, read once and kept current: one subscription however many ferrets. */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DaemonAgendaClient } from '../lib/agenda-client.ts';
import type { SessionAgenda } from '../lib/board-detail.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';

export const useBoardAsks = (
  agenda: Pick<DaemonAgendaClient, 'hydrate' | 'store'>,
  machine: DaemonConnection | undefined,
  sessionIds: readonly string[],
): readonly SessionAgenda[] => {
  const key = sessionIds.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list of sessions
  useEffect(() => {
    if (machine === undefined) return;
    for (const sessionId of sessionIds) {
      void agenda.hydrate(machine, daemonSessionScope(machine, sessionId)).catch(() => {});
    }
  }, [agenda, machine, key]);
  const state = useSyncExternalStore(
    agenda.store.subscribe.bind(agenda.store),
    () => agenda.store.getSnapshot(),
    () => agenda.store.getSnapshot(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list of sessions
  return useMemo(
    () =>
      sessionIds.map(sessionId => ({
        sessionId,
        snapshot:
          machine === undefined
            ? null
            : (state.snapshots.get(daemonSessionKey(daemonSessionScope(machine, sessionId))) ?? null),
      })),
    [state, machine, key],
  );
};
