/**
 * The `ferret.side` panel `ferret-agenda`: one ferret's agenda, its asks grouped by whose turn it is (today's agenda
 * tab and drawer). An item opens on its own ask page; a sub-ferret's panel points at its lead.
 */

import type { PanelProps } from '@ferretry/kernel/manifest';
import { AgendaTab } from '../features/agenda/agenda-tab.tsx';
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
    if (shown === null || subject === undefined) return null;
    const lead = shown.lead;
    return (
      <AgendaClientContext.Provider value={runtime.client}>
        <AgendaTab
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
