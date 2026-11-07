import { useEffect, useSyncExternalStore } from 'react';
import { inboxTargetPath, machineForAgendaLink } from '../lib/agenda-inbox.ts';
import { clearAgendaDeepLink, pendingAgendaDeepLink, subscribeAgendaDeepLink } from '../lib/agenda-deep-link.ts';
import type { AgendaInboxMachine } from './use-agenda-inbox.ts';

/**
 * Opens the card a `#agenda/<id>?session=<sid>` link names, once a paired machine that runs that session has been read.
 * A link no machine runs is dropped, so a stale link never holds the shell waiting.
 */
export function useAgendaDeepLink(
  machines: readonly AgendaInboxMachine[],
  navigate: (to: string, options?: { readonly replace?: boolean }) => void,
): void {
  const link = useSyncExternalStore(subscribeAgendaDeepLink, pendingAgendaDeepLink, pendingAgendaDeepLink);
  useEffect(() => {
    if (link === null || link.sessionId === undefined) {
      if (link !== null) clearAgendaDeepLink();
      return;
    }
    const found = machineForAgendaLink(
      link,
      machines.map(machine => ({
        daemonId: machine.connection.daemonId,
        sessionIds: machine.sessions === null ? null : machine.sessions.map(session => session.config.id),
      })),
    );
    if (found === 'wait') return;
    clearAgendaDeepLink();
    if (found !== undefined) navigate(inboxTargetPath(found, link.sessionId, link.id));
  }, [link, machines, navigate]);
}
