/**
 * The `conversation.above-composer` panel `ferret-agenda-line`: the agenda line above the composer ("● Agenda · 5 need
 * you · 2 with Johnnie ▴") and the drawer its pill opens, for the ferret whose chat this is (the slot's `subject`).
 *
 * The line and the drawer are siblings of the composer, so they mount in the slot Conversation offers there. An item's
 * own view lays over the message list, which a slot above the composer cannot reach: a tapped row opens the item on its
 * own page (the ask page, with the ferret's conversation under it), the same place the ferret's Agenda tab sends it.
 * The agenda exists only while the ferret works in agenda mode (`GET /v1/ferrets/:ferretId/agenda-mode`): with it off,
 * and with nothing sending, the panel draws nothing. While the machine holds the owner's answers the line's right end
 * says so ("Sending to Zoe in 8 s…") and offers Send now.
 */

import type { PanelProps } from '@ferretry/kernel/manifest';
import { useEffect, useMemo, useState } from 'react';
import { AgendaBoardProviders, useAgendaBoardHooks } from '../features/agenda/agenda-board-hooks.tsx';
import { AgendaRepliesNotice } from '../features/agenda/agenda-replies-notice.tsx';
import { useAgenda } from '../features/agenda/agenda.tsx';
import { useAgendaSnapshot } from '../hooks/use-agenda.ts';
import { useAgendaReplies } from '../hooks/use-agenda-replies.ts';
import { useFerretAgenda } from '../hooks/use-ferret-agenda.ts';
import { readSessionAgenda } from '../lib/agenda-api.ts';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { agendaConversationPath } from '../lib/agenda-inbox.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { daemonSessionScope } from '../lib/machine.ts';
import { useRouter } from '../shell.ts';

/** Whether this ferret works in agenda mode; a read that fails says no, so the chat never draws a line it cannot back. */
const useAgendaMode = (runtime: AgendaRuntime, ferret: string): boolean => {
  const [mode, setMode] = useState<{ readonly ferret: string; readonly enabled: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    readSessionAgenda(runtime.client, ferret).then(
      read => live && setMode({ ferret, enabled: read.enabled }),
      () => live && setMode({ ferret, enabled: false }),
    );
    return () => {
      live = false;
    };
  }, [runtime, ferret]);
  return mode?.ferret === ferret && mode.enabled;
};

function AgendaLine({ runtime, ferret }: { readonly runtime: AgendaRuntime; readonly ferret: string }) {
  const daemon = runtime.connection.daemonId;
  const { navigate } = useRouter();
  const board = useAgendaBoardHooks(daemon);
  const scope = useMemo(() => daemonSessionScope(runtime.connection, ferret), [runtime.connection, ferret]);
  // Reads this ferret's board into the store (and names the ferret); the snapshot below is what the line counts.
  const named = useFerretAgenda(runtime, ferret);
  const snapshot = useAgendaSnapshot(runtime.agenda, scope);
  const agendaMode = useAgendaMode(runtime, ferret);
  const replies = useAgendaReplies(runtime.agenda, runtime.connection, scope);
  const ferretName = named?.name ?? ferret;
  // The slot is handed only while something is held: a slot that is present at all makes the line draw a status end.
  const held = replies.secondsLeft !== null || replies.heldForTurn || replies.heldForComposer;
  const agenda = useAgenda({
    agendaMode,
    client: runtime.agenda,
    connection: runtime.connection,
    ferret: ferretName,
    onOpenItem: item => navigate(agendaConversationPath(daemon, ferret, item.id)),
    ...(held
      ? {
          repliesSlot: (
            <AgendaRepliesNotice
              ferret={ferretName}
              heldForComposer={replies.heldForComposer}
              heldForTurn={replies.heldForTurn}
              onSendNow={replies.sendNow}
              secondsLeft={replies.secondsLeft}
              sending={replies.sending}
            />
          ),
        }
      : {}),
    scope,
    snapshot,
    status: runtime.agenda.store.status(scope),
    swipeable: false,
  });
  return (
    <AgendaBoardProviders hooks={board} onNavigate={to => navigate(to)}>
      <AgendaClientContext.Provider value={runtime.client}>{agenda.above}</AgendaClientContext.Provider>
    </AgendaBoardProviders>
  );
}

export function createAgendaLinePanel(runtime: AgendaRuntime) {
  return function AgendaLinePanel({ subject }: PanelProps) {
    if (subject === undefined || subject === '') return null;
    return <AgendaLine ferret={subject} runtime={runtime} />;
  };
}
