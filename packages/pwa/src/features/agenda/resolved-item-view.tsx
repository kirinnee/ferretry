import { useMemo } from 'react';
import type { InboxResolved } from '../../lib/agenda-inbox.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import { storedHistory } from '../../lib/agenda-conversation.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';
import { AgendaItemView } from './agenda-item-view.tsx';
import { defaultAgendaProse } from './agenda-prose.tsx';
import { AgendaSettled } from './agenda-settled.tsx';
import { useAgendaItem } from './use-agenda-item.ts';
import { useItemLifecycle } from './use-item-lifecycle.ts';

/** Machine records have no chat to navigate to. Their headers open the same complete, read-only item view here. */
export function ResolvedItemView({
  row,
  connection,
  onClose,
}: {
  readonly row: InboxResolved;
  readonly connection: DaemonConnection;
  readonly onClose: () => void;
}) {
  const scope = useMemo(() => daemonSessionScope(connection, row.view.config.id), [connection, row.view.config.id]);
  const detail = useAgendaItem(connection, scope, row.record);
  const lifecycle = useItemLifecycle({ connection, scope, client: undefined, item: detail.item, board: [] });
  const item = detail.item;
  if (item === undefined)
    return (
      <div className="fy-inbox-open">
        <p role={detail.error === undefined ? 'status' : 'alert'}>{detail.error ?? 'Reading agenda item…'}</p>
        {detail.error === undefined ? null : (
          <button type="button" onClick={detail.retry}>
            Try again
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  const history =
    lifecycle.conversation === null
      ? itemHistory(item, [])
      : storedHistory(item, lifecycle.conversation, lifecycle.conversationGap);
  return (
    <div className="fy-inbox-open" data-inbox-open-resolved={item.id}>
      <AgendaItemView
        item={item}
        ferret={row.machineName}
        history={history}
        position={{ index: 0, total: 1 }}
        onClose={onClose}
        closeLabel="Back to the Inbox"
        busy={false}
        error={null}
        swipeable={false}
        onAct={() => {}}
        renderProse={defaultAgendaProse}
        versions={lifecycle.versions}
        settled={<AgendaSettled item={item} ferret={row.machineName} busy={false} error={null} />}
      />
    </div>
  );
}
