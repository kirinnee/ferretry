/**
 * The `ferret.side` panel `ferret-agenda`: one ferret's agenda, its asks grouped by whose turn it is (today's agenda
 * tab and drawer). An item opens on its own ask page; a sub-ferret's panel points at its lead.
 */

import type { PanelProps } from '@ferretry/kernel/manifest';
import { AgendaTab } from '../features/agenda/agenda-tab.tsx';
import { useAskFocus } from '../features/agenda/use-ask-focus.ts';
import { useFerretAgenda } from '../hooks/use-ferret-agenda.ts';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { agendaConversationPath } from '../lib/agenda-inbox.ts';
import { useAgendaLinks } from '../lib/agenda-links.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { useRouter } from '../shell.ts';

export function createAgendaPanel(runtime: AgendaRuntime) {
  const daemon = runtime.connection.daemonId;
  return function AgendaPanel({ subject }: PanelProps) {
    const { navigate } = useRouter();
    const links = useAgendaLinks();
    const shown = useFerretAgenda(runtime, subject);
    // A notification tap lands on this ferret's chat AT the ask (`/d/<daemon>/ferrets/<ferret>/chat?ask=A3`): the panel
    // opens that ask's filter and rings its row. An ask that is not this ferret's is simply not found here.
    const asked = useAskFocus();
    if (shown === null || subject === undefined) return null;
    // A refused read is said, never drawn as an empty agenda: "nothing asked" and "could not read" are different facts.
    if (shown.failed)
      return (
        <p className="fy-agenda-panel__empty" data-agenda-tab-failed="" role="alert">
          Couldn’t read this ferret’s agenda.
        </p>
      );
    const lead = shown.lead;
    return (
      <AgendaClientContext.Provider value={runtime.client}>
        <AgendaTab
          focus={asked?.target == null ? null : { target: asked.target, seq: asked.seq }}
          model={shown.model}
          onOpen={item => navigate(agendaConversationPath(daemon, subject, item.id))}
          {...(lead === undefined
            ? {}
            : { lead: { name: lead.name, open: () => navigate(links.chat(daemon, lead.id)) } })}
        />
      </AgendaClientContext.Provider>
    );
  };
}
