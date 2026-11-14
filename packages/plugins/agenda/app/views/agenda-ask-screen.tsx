/**
 * The `agenda-ask` screen (`agenda/:ferret/:ask` under its machine): where a buzz lands. It is the Agenda page opened AT the ask, as
 * today's page opens one from a tapped notification: the card shows while the ask is open, with the ferret's
 * conversation and composer under it (Conversation's panel in the `agenda.conversation` slot), and the reader goes on
 * to the ferret's chat when it is not open any more.
 */

import type { ScreenProps } from '@ferretry/kernel/manifest';
import { AgendaBoardProviders, laneEditorOf, useAgendaBoardHooks } from '../features/agenda/agenda-board-hooks.tsx';
import { AgendaCardConversation } from '../features/agenda/agenda-conversation-slot.tsx';
import { AgendaInboxPage } from '../features/agenda/agenda-inbox-page.tsx';
import { AgendaInboxContext, useRuntimeInbox } from '../hooks/use-agenda-inbox.ts';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { useAgendaLinks } from '../lib/agenda-links.ts';
import type { AgendaFleet } from '../lib/agenda-fleet.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { AgendaIdSchema } from '@ferretry/core-asks/contract';
import { useLayoutMode, useRouter } from '../shell.ts';

export function createAgendaAskScreen(runtime: AgendaRuntime, fleet?: AgendaFleet) {
  const daemon = runtime.connection.daemonId;
  return function AgendaAskScreen({ params }: ScreenProps) {
    const { navigate } = useRouter();
    const links = useAgendaLinks();
    // Board's hooks for this machine: Done · closes, a notice's Start and Close, Edit's lane editor and `&F12` proof.
    const board = useAgendaBoardHooks(daemon);
    const inbox = useRuntimeInbox(runtime, laneEditorOf(board), fleet);
    const phone = useLayoutMode() === 'drawer';
    const ferret = params.ferret;
    const ask = AgendaIdSchema.safeParse(params.ask);
    // A malformed ask in the address draws the Inbox with nothing open, as today's page did.
    const open =
      ferret === undefined || !ask.success
        ? undefined
        : { daemonId: daemon, sessionId: ferret, id: ask.data, settled: inbox.settled === true };
    return (
      <AgendaBoardProviders hooks={board} onNavigate={to => navigate(to)}>
        <AgendaClientContext.Provider value={runtime.client}>
          <AgendaInboxContext.Provider value={inbox}>
            <AgendaInboxPage
              inbox={inbox}
              phone={phone}
              clearPort={runtime.clearPort}
              {...(open === undefined ? {} : { open })}
              onOpenSettled={opened =>
                navigate(opened || ferret === undefined ? links.agenda(daemon) : links.chat(daemon, ferret), {
                  replace: true,
                })
              }
              onNavigate={to => navigate(to)}
              onItemOpened={card => void runtime.itemOpened(card.view.config.id, card.item.id)}
              renderComposer={card => <AgendaCardConversation card={card} daemon={daemon} inbox={inbox} />}
            />
          </AgendaInboxContext.Provider>
        </AgendaClientContext.Provider>
      </AgendaBoardProviders>
    );
  };
}
