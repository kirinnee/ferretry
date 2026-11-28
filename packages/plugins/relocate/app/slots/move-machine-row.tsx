/**
 * "Move to another machine…" IN THE FERRET'S ACTIONS MENU (`ferrets.actions-row`). Relocate owns the move, so the row is
 * Relocate's. The panel draws nothing of its own: it offers the row only while this connection may change the ferret AND
 * another machine is paired where Relocate is on, takes it back otherwise, and opens the move from `run`.
 */
import { daemonOfClient, useEveryDaemon } from '@ferretry/app';
import { type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { MoveMachine } from '../features/move-machine.tsx';
import type { MovedStore } from '../lib/moved-store.ts';

const MOVE_MACHINE_ROW_ID = 'move-machine';

const rowOf = (run: () => void): ActionsRowOffer => ({
  kind: 'run',
  id: MOVE_MACHINE_ROW_ID,
  label: 'Move to another machine…',
  group: 'move',
  order: 30,
  run,
});

/** A row is offered only to a caller who may control the ferret and only where there is another machine to move to. */
export const offersMove = (canControl: boolean, daemons: number): boolean => canControl && daemons >= 2;

function MoveMachineRow({
  client,
  store,
  ferret,
  name,
  canControl,
  offer,
}: {
  readonly client: PluginClient;
  readonly store: MovedStore;
  readonly ferret: string;
  readonly name: string;
  readonly canControl: boolean;
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
}): ReactNode {
  const reaches = useEveryDaemon();
  const here = useMemo(() => daemonOfClient(client), [client]);
  const from = reaches.find(reach => reach.daemon === here);
  const others = useMemo(() => reaches.filter(reach => reach.daemon !== here), [reaches, here]);
  const [open, setOpen] = useState(false);
  const offered = offersMove(canControl, from === undefined ? 0 : reaches.length);
  useEffect(() => {
    if (!offered) {
      offer(MOVE_MACHINE_ROW_ID, null);
      return;
    }
    offer(
      MOVE_MACHINE_ROW_ID,
      rowOf(() => setOpen(true)),
    );
    return () => offer(MOVE_MACHINE_ROW_ID, null);
  }, [offer, offered]);
  return open && offered && from !== undefined ? (
    <MoveMachine
      candidates={others}
      ferret={ferret}
      from={from}
      name={name}
      onClose={() => setOpen(false)}
      onMoved={() => void store.refresh()}
    />
  ) : null;
}

export const createMoveMachineRowPanel = (client: PluginClient, store: MovedStore): AppComponent<PanelProps> =>
  function MoveMachineRowPanel(props: PanelProps) {
    return isActionsRowSlotProps(props) ? (
      <MoveMachineRow
        canControl={props.canControl}
        client={client}
        ferret={props.ferret}
        name={props.name}
        offer={props.offer}
        store={store}
      />
    ) : null;
  };
