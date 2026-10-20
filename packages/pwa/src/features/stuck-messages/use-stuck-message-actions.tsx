/**
 * "CLEAR STUCK MESSAGES" IN A FERRET'S ACTIONS MENU: one confirm entry that takes back every message
 * of the session that nothing has proved arrived.
 *
 * A message is STUCK when the reader can still see it waiting (sending, in the agent's queue, typed into
 * its composer, or settled without arriving), nothing proved it delivered, nobody has cancelled it and it
 * is not deliberately held for a revive (`isStuckSend` — the same rule that decides which rows stay on
 * screen, so the count in the question is the number of rows the reader sees).
 *
 * Cancelling is not equally undoable everywhere, and the confirm says so BEFORE the click: a message
 * typed in the composer is erased from it, but one the agent is already holding in its own queue can only
 * be removed here and may still be read. Each row says afterwards which of the two happened to it.
 *
 * The entry is a plain {@link SessionActionContribution} built by {@link clearStuckMessagesContribution},
 * so any surface that can list a session's sends (this page's menu, a sidebar row's menu) mounts the same
 * one.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { Eraser } from 'lucide-react';
import { useMemo } from 'react';
import { isStuckSend } from '../../lib/ledger-placement.ts';
import type { LedgerSendRecord } from '../../lib/send-ledger.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';

export const CLEAR_STUCK_MESSAGES_ACTION_ID = 'clear-stuck-messages';

/** What the entry needs to know about the ferret the menu is for. */
export interface StuckMessageActionContext {
  readonly canControl: boolean;
}

export const NO_STUCK_MESSAGES_REASON = 'no stuck messages';

export const stuckSends = (sends: readonly LedgerSendRecord[], nowMs: number = Date.now()): LedgerSendRecord[] =>
  sends.filter(record => isStuckSend(record, nowMs));

/**
 * Takes back each message in turn — one at a time, because the daemon types into one pane and a second
 * cancel racing the first could read a half-erased composer — and then asks for fresh evidence either
 * way. A refusal does not stop the rest; the failures are reported together at the end, with the
 * daemon's own sentence for the first.
 */
export const cancelAllStuck = async (
  client: Pick<IFyApiClient, 'cancelSend'> | null,
  sessionId: string,
  stuck: readonly LedgerSendRecord[],
  refresh: () => void,
): Promise<void> => {
  if (client === null) throw new Error('this page is not connected to the machine');
  const failures: string[] = [];
  for (const record of stuck) {
    try {
      await client.cancelSend(sessionId, record.sendId);
    } catch (error) {
      failures.push(error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : 'refused');
    }
  }
  refresh();
  if (failures.length === 0) return;
  const rest = failures.length === stuck.length ? '' : ' The rest were cleared.';
  throw new Error(`${failures.length} of ${stuck.length} could not be cleared — ${failures[0]}.${rest}`);
};

export const clearStuckMessagesContribution = (
  stuck: readonly LedgerSendRecord[],
  clear: () => Promise<void>,
): SessionActionContribution<StuckMessageActionContext> => ({
  group: 'session',
  order: 40,
  build: context => {
    if (!context.canControl) return null;
    return {
      kind: 'confirm',
      id: CLEAR_STUCK_MESSAGES_ACTION_ID,
      label: 'Clear stuck messages',
      icon: Eraser,
      ...(stuck.length === 0 ? { unavailable: NO_STUCK_MESSAGES_REASON } : { detail: String(stuck.length) }),
      question: `Clear ${stuck.length} stuck ${stuck.length === 1 ? 'message' : 'messages'}?`,
      consequence:
        'Ones typed into the agent’s composer are erased from it. Ones the agent is already holding in its own queue are only removed here, so it may still read them.',
      confirmLabel: 'Clear messages',
      run: clear,
    };
  },
});

export interface StuckMessageActions {
  readonly contributions: readonly SessionActionContribution<StuckMessageActionContext>[];
  /** How many messages the entry would clear right now. */
  readonly count: number;
}

export function useStuckMessageActions({
  client,
  sessionId,
  sends,
  refresh,
}: {
  readonly client: Pick<IFyApiClient, 'cancelSend'> | null;
  readonly sessionId: string;
  readonly sends: readonly LedgerSendRecord[];
  readonly refresh: () => void;
}): StuckMessageActions {
  const stuck = useMemo(() => stuckSends(sends), [sends]);
  const contributions = useMemo(
    () => [clearStuckMessagesContribution(stuck, () => cancelAllStuck(client, sessionId, stuck, refresh))],
    [client, refresh, sessionId, stuck],
  );
  return { contributions, count: stuck.length };
}
