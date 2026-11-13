/**
 * "INTERRUPT TURN" IN THE FERRET'S ACTIONS ▾ MENU (`panels['interrupt-row']`, slot `ferrets.actions-row`). The turn is
 * Conversation's, so its button is too (`turn.interrupt`): today's menu listed it for a ferret that is not stopped, and
 * only to someone who may control it. The panel draws nothing; it offers the row while that holds and takes it back
 * when it stops holding or the menu unmounts.
 */

import {
  type FerretState,
  FerretStateSchema,
  FerretsChanged,
  isActionsRowSlotProps,
} from '@ferretry/core-ferrets/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useConversationClient } from '../client.ts';

export const INTERRUPT_ROW_ID = 'interrupt-turn';

const StateRead = z.looseObject({ state: FerretStateSchema });

export function InterruptRowPanel(props: PanelProps): null {
  const client = useConversationClient();
  const slot = isActionsRowSlotProps(props) ? props : null;
  const ferret = slot?.ferret;
  const offer = slot?.offer;
  const allowed = slot?.canControl === true;
  const [state, setState] = useState<FerretState | null>(null);

  useEffect(() => {
    if (ferret === undefined || !allowed) return;
    let live = true;
    const read = (): void => {
      client.call('GET /v1/ferrets/:ferretId', { params: { ferretId: ferret } }).then(
        answer => {
          const parsed = StateRead.safeParse(answer);
          if (live) setState(parsed.success ? parsed.data.state : null);
        },
        () => {
          if (live) setState(null);
        },
      );
    };
    read();
    const cancel = client.subscribe(FerretsChanged, payload => {
      if (payload.ferret === ferret) read();
    });
    return () => {
      live = false;
      cancel();
    };
  }, [client, ferret, allowed]);

  const running = state !== null && state !== 'stopped';
  useEffect(() => {
    if (ferret === undefined || offer === undefined) return;
    if (!allowed || !running) {
      offer(INTERRUPT_ROW_ID, null);
      return;
    }
    offer(INTERRUPT_ROW_ID, {
      kind: 'run',
      id: INTERRUPT_ROW_ID,
      label: 'Interrupt turn',
      group: 'ferret',
      order: 5,
      run: async () => {
        await client.call('POST /v1/ferrets/:ferretId/interrupt', {
          params: { ferretId: ferret },
          body: {},
          headers: { 'x-fy-request-id': crypto.randomUUID() },
        });
      },
    });
    return () => offer(INTERRUPT_ROW_ID, null);
  }, [client, ferret, offer, allowed, running]);

  return null;
}
