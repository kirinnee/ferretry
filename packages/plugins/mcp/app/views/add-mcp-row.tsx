/**
 * `ferrets.actions-row` — MCP's one row in a ferret's Actions ▾ menu, "Add MCP server…". The menu is Ferrets'; this row
 * reaches it through the slot and opens its own form from `run`. Offered only to a caller who may control the ferret.
 */
import { type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { AddMcpDialog } from './add-mcp-dialog.tsx';

const ADD_MCP_ACTION_ID = 'add-mcp';
const ADD_MCP_ROW_LABEL = 'Add MCP server…';

const rowOf = (run: () => void): ActionsRowOffer => ({
  kind: 'run',
  id: ADD_MCP_ACTION_ID,
  label: ADD_MCP_ROW_LABEL,
  group: 'ferret',
  order: 10,
  run,
});

function AddMcpRow({
  client,
  ferret,
  name,
  canControl,
  offer,
}: {
  readonly client: PluginClient;
  readonly ferret: string;
  readonly name: string;
  readonly canControl: boolean;
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!canControl) {
      offer(ADD_MCP_ACTION_ID, null);
      return;
    }
    offer(
      ADD_MCP_ACTION_ID,
      rowOf(() => setOpen(true)),
    );
    return () => offer(ADD_MCP_ACTION_ID, null);
  }, [canControl, offer]);
  return open && canControl ? (
    <AddMcpDialog client={client} ferretId={ferret} name={name} onClose={() => setOpen(false)} />
  ) : null;
}

export const createAddMcpRowPanel = (client: PluginClient): AppComponent<PanelProps> =>
  function AddMcpRowPanel(props: PanelProps) {
    return isActionsRowSlotProps(props) ? (
      <AddMcpRow
        canControl={props.canControl}
        client={client}
        ferret={props.ferret}
        name={props.name}
        offer={props.offer}
      />
    ) : null;
  };
