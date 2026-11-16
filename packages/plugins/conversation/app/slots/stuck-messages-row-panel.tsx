/**
 * "CLEAR STUCK MESSAGES", "DISMISS ALL CANCELLED" AND "QUEUE…" IN THE FERRET'S ACTIONS ▾ MENU (`panels['stuck-messages-row']`,
 * slot `ferrets.actions-row`). The messages and their fates are Conversation's, so their rows are too: the two stuck-message
 * rows come from `use-stuck-message-actions.tsx` (the same rule that decides which rows stay on the chat), offered only to
 * someone who may control the ferret, and "Queue…" brings this ferret's `queue` side panel on screen.
 *
 * The panel draws nothing. It reads the ferret's send ledger itself (the chat's own read, kept fresh by the same
 * wake-ups), because the menu is mounted where no chat is: the rows say what is stuck whatever page the menu is on.
 */

import { useFerretWorkspace } from '@ferretry/app';
import { FerretsChanged, type ActionsRowOffer, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import { QueueChanged } from '@ferretry/core-mailbox/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSent } from '../../contract/index.ts';
import { useConversationClient } from '../client.ts';
import { type LedgerSendRecord, parseLedgerSendsResponse, readLedgerSends } from '../chat/send-ledger.ts';
import {
  CLEAR_STUCK_MESSAGES_ACTION_ID,
  DISMISS_CANCELLED_ACTION_ID,
  useStuckMessageActions,
} from '../chat/use-stuck-message-actions.tsx';
import { useSendView } from '../queue/use-send-view.ts';

export const OPEN_QUEUE_ROW_ID = 'open-queue';

/** The id Conversation declares for a ferret's queue on `ferret.side`. */
export const QUEUE_PANEL_ID = 'queue';

/** How long the menu's reading of the ledger may be old: a wake-up refreshes it sooner. */
const SENDS_POLL_MS = 10_000;

const ROW_IDS = [CLEAR_STUCK_MESSAGES_ACTION_ID, DISMISS_CANCELLED_ACTION_ID, OPEN_QUEUE_ROW_ID] as const;

export function StuckMessagesRowPanel(props: PanelProps): null {
  const client = useConversationClient();
  const slot = isActionsRowSlotProps(props) ? props : null;
  const ferret = slot?.ferret;
  const offer = slot?.offer;
  const allowed = slot?.canControl === true;
  const workspace = useFerretWorkspace();
  const [sends, setSends] = useState<readonly LedgerSendRecord[]>([]);
  const reread = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (ferret === undefined || !allowed) {
      setSends([]);
      return;
    }
    let live = true;
    const read = (): void => {
      readLedgerSends(client, ferret).then(
        rows => {
          if (live) setSends(parseLedgerSendsResponse(rows));
        },
        // A failed read leaves what was last read: the rows say what the ledger last proved.
        () => undefined,
      );
    };
    reread.current = read;
    read();
    const mine = (payload: { readonly ferret: string }): void => {
      if (payload.ferret === ferret) read();
    };
    const cancels = [
      client.subscribe(QueueChanged, mine),
      client.subscribe(MessageSent, mine),
      client.subscribe(FerretsChanged, mine),
    ];
    const timer = setInterval(read, SENDS_POLL_MS);
    return () => {
      live = false;
      reread.current = () => undefined;
      clearInterval(timer);
      for (const cancel of cancels) cancel();
    };
  }, [client, ferret, allowed]);

  const refresh = useCallback(() => reread.current(), []);
  const { view, dismiss } = useSendView(sends);
  const { contributions } = useStuckMessageActions({
    client,
    ferretId: ferret ?? '',
    sends,
    refresh,
    view,
    dismiss,
  });

  // The queue is this ferret's own panel: the link is offered only where the workspace around the menu is on this ferret
  // and places the panel (a layout that left it out keeps no link that would bring nothing on screen).
  const showQueue =
    workspace !== null && workspace.ferret === ferret && workspace.shows(QUEUE_PANEL_ID)
      ? workspace.showPanel
      : undefined;

  useEffect(() => {
    if (ferret === undefined || offer === undefined) return;
    const rows: ActionsRowOffer[] = [];
    if (allowed) {
      for (const [index, contribution] of contributions.entries()) {
        const entry = contribution.build({ canControl: allowed });
        if (entry === null) continue;
        const common = {
          id: entry.id,
          label: entry.label,
          group: 'ferret' as const,
          order: 40 + index,
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          ...(entry.danger === undefined ? {} : { danger: entry.danger }),
          ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable }),
        };
        rows.push(
          entry.kind === 'confirm'
            ? {
                ...common,
                kind: 'confirm',
                question: entry.question,
                consequence: entry.consequence,
                confirmLabel: entry.confirmLabel,
                run: entry.run,
              }
            : { ...common, kind: 'run', run: entry.run },
        );
      }
    }
    if (showQueue !== undefined)
      rows.push({
        kind: 'run',
        id: OPEN_QUEUE_ROW_ID,
        label: 'Queue…',
        group: 'ferret',
        order: 45,
        run: () => showQueue(QUEUE_PANEL_ID),
      });
    const offered = new Set(rows.map(row => row.id));
    for (const row of rows) offer(row.id, row);
    for (const id of ROW_IDS) if (!offered.has(id)) offer(id, null);
    return () => {
      for (const id of ROW_IDS) offer(id, null);
    };
  }, [ferret, offer, allowed, contributions, showQueue]);

  return null;
}
