/**
 * The `agenda` screen: the Agenda page, every ferret's asks and notices on this machine in one list (today's Inbox
 * page). The page itself is this half's; the runtime (the agenda client, the ferrets) is the half's one, shared with
 * every view; the open card's conversation is Conversation's panel in the `agenda.conversation` slot.
 */

import type { ScreenProps } from '@ferretry/kernel/manifest';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { AgendaBoardProviders, laneEditorOf, useAgendaBoardHooks } from '../features/agenda/agenda-board-hooks.tsx';
import { AgendaConversationSlot } from '../features/agenda/agenda-conversation-slot.tsx';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { useAskFocus } from '../features/agenda/use-ask-focus.ts';
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
    // Board's hooks for this machine: Done · closes, a notice's Start and Close, Edit's lane editor and `&F12` proof.
    const board = useAgendaBoardHooks(daemon);
    const inbox = useRuntimeInbox(runtime, laneEditorOf(board));
    const phone = useLayoutMode() === 'drawer';
    // A machine ask's push opens `/agenda?ask=A3`: the page opens that ask's card once it is among the open ones.
    const asked = useAskFocus();
    return (
      <AgendaBoardProviders hooks={board} onNavigate={to => navigate(to)}>
        <AgendaClientContext.Provider value={runtime.client}>
          <AgendaInboxContext.Provider value={inbox}>
            <AgendaInboxPage
              inbox={inbox}
              phone={phone}
              clearPort={runtime.clearPort}
              onNavigate={to => navigate(to)}
              open={
                asked?.target == null
                  ? null
                  : {
                      daemonId: daemon,
                      sessionId: MACHINE_AGENDA_ID,
                      id: asked.target,
                      settled: inbox.settled === true,
                    }
              }
              // An ask that is no longer open ends the request: the address drops `?ask=` and the page stays on the list.
              onOpenSettled={opened => {
                if (!opened) navigate(links.agenda(daemon), { replace: true });
              }}
              from={inboxSourceFromSearch(window.location.search)}
              onClearFrom={() => navigate(links.agenda(daemon), { replace: true })}
              onItemOpened={card => void runtime.itemOpened(card.view.config.id, card.item.id)}
              renderComposer={card => (
                <AgendaConversationSlot ask={card.item.id} daemon={daemon} ferret={card.view.config.id} />
              )}
            />
          </AgendaInboxContext.Provider>
        </AgendaClientContext.Provider>
      </AgendaBoardProviders>
    );
  };
}
