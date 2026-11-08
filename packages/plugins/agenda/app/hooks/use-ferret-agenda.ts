/**
 * ONE FERRET'S AGENDA, for its side panel: its board read through the half's one agenda client (and kept current by
 * Asks' changes, which the runtime hears), shaped into the Agenda tab's model. A sub-ferret's items are raised on its
 * lead's agenda, so its panel names the lead.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { agendaTabModel, type AgendaTabModel } from '../lib/agenda-tab.ts';
import { sessionsBarNames } from '../lib/ferret-names.ts';
import { daemonSessionScope } from '../lib/machine.ts';

export interface FerretAgenda {
  readonly model: AgendaTabModel;
  /** The read was refused or never answered: the model is empty because nothing was read, not because nothing is asked. */
  readonly failed: boolean;
  /** The lead whose agenda this sub-ferret's items are on. */
  readonly lead?: { readonly id: string; readonly name: string };
}

export const useFerretAgenda = (runtime: AgendaRuntime, ferret: string | undefined): FerretAgenda | null => {
  const scope = useMemo(
    () => (ferret === undefined || ferret === '' ? undefined : daemonSessionScope(runtime.connection, ferret)),
    [runtime.connection, ferret],
  );
  useEffect(() => {
    if (scope !== undefined) runtime.agenda.hydrate(runtime.connection, scope).catch(() => undefined);
  }, [runtime, scope]);
  const store = runtime.agenda.store;
  // Subscribed so a board that lands re-renders; the board itself is read from the store below.
  useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
  const board = scope === undefined ? undefined : store.agenda(scope);
  // A refresh that fails keeps the board already read; only a board never read is refused.
  const failed = scope !== undefined && board === undefined && store.status(scope) === 'error';
  const fleet = useSyncExternalStore(runtime.ferrets.subscribe, runtime.ferrets.getSnapshot);
  return useMemo(() => {
    if (scope === undefined) return null;
    const views = fleet.daemons.get(runtime.connection.daemonId)?.sessions ?? [];
    const view = views.find(candidate => candidate.config.id === scope.sessionId);
    const name = view === undefined ? scope.sessionId : (sessionsBarNames(view).ferret ?? sessionsBarNames(view).title);
    const model = agendaTabModel({
      items: board?.items ?? [],
      resolved: board?.resolved ?? [],
      ferret: name,
      now: Date.now(),
    });
    const parent = view?.config.parent === undefined ? undefined : views.find(v => v.config.id === view.config.parent);
    return {
      model,
      failed,
      ...(parent === undefined
        ? {}
        : { lead: { id: parent.config.id, name: sessionsBarNames(parent).ferret ?? sessionsBarNames(parent).title } }),
    };
  }, [scope, board, failed, fleet, runtime]);
};
