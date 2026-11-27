/**
 * "FORK INTO A NEW FERRET…" IN THE FERRET'S ACTIONS ▾ MENU (`panels['fork-row']`, slot `ferrets.actions-row`). Conversation
 * owns the fork (its route, its message selection, its attachments), so the row is Conversation's too. The panel draws
 * nothing of its own: it offers the row while this connection may change the ferret and may fork on this machine, takes it
 * back when it may not, and opens {@link ForkDialog} from `run` — the same form a message's "Fork from here…" opens, at the
 * latest message.
 */

import { type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useState } from 'react';
import { ForkDialog, useForkControl } from '../fork/fork-dialog.tsx';

export const FORK_ROW_ID = 'fork';

const rowOf = (run: () => void, unavailable: string | undefined): ActionsRowOffer => ({
  kind: 'run',
  id: FORK_ROW_ID,
  label: 'Fork into a new ferret…',
  group: 'ferret',
  order: 25,
  ...(unavailable === undefined ? {} : { unavailable }),
  run,
});

export function ForkRowPanel(props: PanelProps): ReactNode {
  const slot = isActionsRowSlotProps(props) ? props : null;
  const ferret = slot?.ferret;
  const offer = slot?.offer;
  const allowed = slot?.canControl === true;
  const control = useForkControl();
  const [open, setOpen] = useState(false);
  const offered = allowed && control.shown;
  const unavailable = control.enabled ? undefined : (control.note ?? 'This device may not fork on this machine.');

  useEffect(() => {
    if (offer === undefined) return;
    if (!offered) {
      offer(FORK_ROW_ID, null);
      return;
    }
    offer(
      FORK_ROW_ID,
      rowOf(() => setOpen(true), unavailable),
    );
    return () => offer(FORK_ROW_ID, null);
  }, [offer, offered, unavailable]);

  return open && offered && ferret !== undefined ? <ForkDialog ferret={ferret} onClose={() => setOpen(false)} /> : null;
}
