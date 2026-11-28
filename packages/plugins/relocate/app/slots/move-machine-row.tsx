/**
 * "Move to another machine…" IN THE FERRET'S ACTIONS MENU (`ferrets.actions-row`). Relocate owns the move, so the row is
 * Relocate's. The panel draws nothing of its own: it offers the row only while this connection may change the ferret AND
 * the source is reachable. With no available target it opens recovery only, so an interrupted export can still be released.
 */
import { daemonOfClient, useEveryDaemon, type DaemonReach } from '@ferretry/app';
import { type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MoveMachine } from '../features/move-machine.tsx';
import { MovedMark } from '../features/moved-mark.tsx';
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

/** The source alone is enough for recovery. The dialog offers a new move only when a target is available. */
export const offersMove = (canControl: boolean, daemons: number): boolean => canControl && daemons >= 1;

/** Unknown or refused grants never offer a move; a press may confirm a known step-up or unlock. */
const mayMove = (reach: DaemonReach): boolean =>
  reach.online &&
  [
    ['fleet', 'configure'],
    ['filesystem', 'use'],
  ].every(([capability, axis]) => {
    const kind = reach.authority(capability as 'fleet' | 'filesystem', axis as 'configure' | 'use').kind;
    return kind === 'open' || kind === 'step-up' || kind === 'locked';
  });

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
  const others = useMemo(() => reaches.filter(reach => reach.daemon !== here && mayMove(reach)), [reaches, here]);
  const ledger = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [open, setOpen] = useState(false);
  const offered = offersMove(
    canControl && ledger.moved[ferret] === undefined && from !== undefined && mayMove(from),
    others.length + 1,
  );
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
  if (ledger.moved[ferret] !== undefined && !open) return <MovedMark ferret={ferret} store={store} />;
  // Withdrawing the menu row must not dismiss the move's progress or recovery receipt.
  return open && from !== undefined ? (
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
