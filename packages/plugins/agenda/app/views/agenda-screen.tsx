/**
 * The `agenda` screen: the Agenda page, every ferret's asks and notices on this machine in one list (today's Inbox
 * page). The page itself is this half's; the runtime (the agenda client, the ferrets) is the half's one, shared with
 * every view; the open card's conversation is Conversation's panel in the `agenda.conversation` slot.
 */

import type { ScreenProps } from '@ferretry/kernel/manifest';
import { AgendaConversationSlot } from '../features/agenda/agenda-conversation-slot.tsx';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { AgendaInboxContext, useRuntimeInbox } from '../hooks/use-agenda-inbox.ts';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { inboxSourceFromSearch } from '../lib/agenda-inbox-list.ts';
import { useAgendaLinks } from '../lib/agenda-links.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { useLayoutMode, useRouter } from '../shell.ts';

export function createAgendaScreen(runtime: AgendaRuntime) {
  const daemon = runtime.connection.daemonId;
  return function AgendaScreen(_props: ScreenProps) {
    const { navigate } = useRouter();
    const links = useAgendaLinks();
    const inbox = useRuntimeInbox(runtime, project => links.lanes(daemon, project));
    const phone = useLayoutMode() === 'drawer';
    return (
      <AgendaClientContext.Provider value={runtime.client}>
        <AgendaInboxContext.Provider value={inbox}>
          <AgendaInboxPage
            inbox={inbox}
            phone={phone}
            clearPort={runtime.clearPort}
            onNavigate={to => navigate(to)}
            from={inboxSourceFromSearch(window.location.search)}
            onClearFrom={() => navigate(links.agenda(daemon), { replace: true })}
            onItemOpened={card => void runtime.itemOpened(card.view.config.id, card.item.id)}
            renderComposer={card => (
              <AgendaConversationSlot ask={card.item.id} daemon={daemon} ferret={card.view.config.id} />
            )}
          />
        </AgendaInboxContext.Provider>
      </AgendaClientContext.Provider>
    );
  };
}
