/**
 * The `agenda-ask` screen (`/agenda/:ferret/:ask`): where a buzz lands. It is the Agenda page opened AT the ask, as
 * today's page opens one from a tapped notification: the card shows while the ask is open, and the reader goes on to
 * the ferret's conversation when it is not.
 */

import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { agendaConversationPath } from '../lib/agenda-inbox.ts';
import { useAgendaInbox } from '../hooks/use-agenda-inbox.ts';
import { daemonAgendaPath, useAgendaItemOpened, useAppStore, useLayoutMode, useRouter } from '../shell.ts';

export function createAgendaAskScreen(client: PluginClient) {
  return function AgendaAskScreen({ params }: ScreenProps) {
    const { navigate, route } = useRouter();
    const store = useAppStore();
    const inbox = useAgendaInbox();
    const phone = useLayoutMode() === 'drawer';
    const itemOpened = useAgendaItemOpened();
    const ferret = params.ferret;
    const ask = params.ask;
    if (inbox === null || ferret === undefined || ask === undefined) return null;
    const connection = inbox.machines[0]?.connection;
    return (
      <AgendaClientContext.Provider value={client}>
        <AgendaInboxPage
          inbox={inbox}
          phone={phone}
          clearPort={store.clearPort}
          open={
            connection === undefined
              ? null
              : { daemonId: connection.daemonId, sessionId: ferret, id: ask, settled: inbox.settled }
          }
          onOpenSettled={(opened: boolean) =>
            navigate(
              opened || connection === undefined
                ? daemonAgendaPath(route.daemon)
                : agendaConversationPath(connection.daemonId, ferret, ask),
              { replace: true },
            )
          }
          onNavigate={navigate}
          onItemOpened={(card: { daemonId: string; view: { config: { id: string } }; item: { id: string } }) => {
            const target = inbox.connectionFor(card.daemonId);
            if (target !== undefined) void itemOpened(target, card.view.config.id, card.item.id);
          }}
        />
      </AgendaClientContext.Provider>
    );
  };
}

export default createAgendaAskScreen;
