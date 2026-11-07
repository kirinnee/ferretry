/**
 * The `agenda` screen: the Agenda page, every paired machine's asks and notices in one list (today's Inbox page).
 * The host data (the merged agenda model, the router, the layout mode, the clear-agents port) comes from the shell;
 * the page itself is this half's.
 */

import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { inboxSourceFromSearch } from '../lib/agenda-inbox-list.ts';
import { useAgendaInbox } from '../hooks/use-agenda-inbox.ts';
import {
  MachineNotificationList,
  NotificationsOffBanner,
  useAgendaItemOpened,
  useAppStore,
  useLayoutMode,
  usePairedMachineNotifications,
  useRouter,
} from '../shell.ts';

export function createAgendaScreen(client: PluginClient) {
  return function AgendaScreen(_props: ScreenProps) {
    const { navigate } = useRouter();
    const store = useAppStore();
    const inbox = useAgendaInbox();
    const phone = useLayoutMode() === 'drawer';
    const machineNotifications = usePairedMachineNotifications();
    const itemOpened = useAgendaItemOpened();
    if (inbox === null) return null;
    return (
      <AgendaClientContext.Provider value={client}>
        <AgendaInboxPage
          inbox={inbox}
          phone={phone}
          clearPort={store.clearPort}
          onNavigate={navigate}
          from={inboxSourceFromSearch(window.location.search)}
          onClearFrom={() => navigate('/agenda')}
          onItemOpened={(card: { daemonId: string; view: { config: { id: string } }; item: { id: string } }) => {
            const target = inbox.connectionFor(card.daemonId);
            if (target !== undefined) void itemOpened(target, card.view.config.id, card.item.id);
          }}
          banner={
            <NotificationsOffBanner
              rows={machineNotifications.rows}
              canEnrol={machineNotifications.canEnrol}
              busy={machineNotifications.busy}
              onEnable={machineNotifications.enable}
            />
          }
          notifications={
            <MachineNotificationList
              rows={machineNotifications.rows}
              canEnrol={machineNotifications.canEnrol}
              busy={machineNotifications.busy}
              failures={machineNotifications.failures}
              onEnable={machineNotifications.enable}
              onDisable={machineNotifications.disable}
              onTurnOnAll={machineNotifications.turnOnAll}
              onToggleShown={machineNotifications.toggleShown}
            />
          }
        />
      </AgendaClientContext.Provider>
    );
  };
}

export default createAgendaScreen;
