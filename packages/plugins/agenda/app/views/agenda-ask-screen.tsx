/**
 * The `agenda-ask` screen (`agenda/:ferret/:ask` under its machine): where a buzz lands. It is the Agenda page opened AT the ask, as
 * today's page opens one from a tapped notification: the card shows while the ask is open, with the ferret's
 * conversation and composer under it (Conversation's panel in the `agenda.conversation` slot), and the reader goes on
 * to the ferret's chat when it is not open any more.
 */

import type { ScreenProps } from '@ferretry/kernel/manifest';
import { AgendaConversationSlot } from '../features/agenda/agenda-conversation-slot.tsx';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { AgendaInboxContext, useRuntimeInbox } from '../hooks/use-agenda-inbox.ts';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { useAgendaLinks } from '../lib/agenda-links.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { AgendaIdSchema } from '../wire/index.ts';
import { useLayoutMode, useRouter } from '../shell.ts';

export function createAgendaAskScreen(runtime: AgendaRuntime) {
  const daemon = runtime.connection.daemonId;
  return function AgendaAskScreen({ params }: ScreenProps) {
    const { navigate } = useRouter();
    const links = useAgendaLinks();
    const inbox = useRuntimeInbox(runtime, project => links.lanes(daemon, project));
    const phone = useLayoutMode() === 'drawer';
    const ferret = params.ferret;
    const ask = AgendaIdSchema.safeParse(params.ask);
    if (ferret === undefined || !ask.success) return null;
    return (
      <AgendaClientContext.Provider value={runtime.client}>
        <AgendaInboxContext.Provider value={inbox}>
          <AgendaInboxPage
            inbox={inbox}
            phone={phone}
            clearPort={runtime.clearPort}
            open={{ daemonId: daemon, sessionId: ferret, id: ask.data, settled: inbox.settled === true }}
            onOpenSettled={opened =>
              navigate(opened ? links.agenda(daemon) : links.chat(daemon, ferret), { replace: true })
            }
            onNavigate={to => navigate(to)}
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
