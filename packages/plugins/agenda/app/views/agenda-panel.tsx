/**
 * The `ferret.side` panel `ferret-agenda`: one ferret's agenda, its asks grouped by whose turn it is (today's agenda
 * tab and drawer). The model is built from the ferret's agenda ledger, which the shell reads once for every surface.
 */

import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { AgendaTab } from '../features/agenda/agenda-tab.tsx';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { agendaConversationPath } from '../lib/agenda-inbox.ts';
import { useFerretAgendaModel, useRouter } from '../shell.ts';

export function createAgendaPanel(client: PluginClient) {
  return function AgendaPanel({ subject }: PanelProps) {
    const { navigate } = useRouter();
    const shown = useFerretAgendaModel(subject);
    if (shown === null) return null;
    return (
      <AgendaClientContext.Provider value={client}>
        <AgendaTab
          model={shown.model}
          onOpen={(item: { id: string }) => navigate(agendaConversationPath(shown.daemonId, shown.ferret, item.id))}
          {...(shown.lead === undefined ? {} : { lead: shown.lead })}
        />
      </AgendaClientContext.Provider>
    );
  };
}

export default createAgendaPanel;
