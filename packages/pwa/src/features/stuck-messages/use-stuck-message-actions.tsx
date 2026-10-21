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
 * It also puts the cancelled and given-up notes away (on this device, via `send-dismissals.ts`): a cleared
 * message that stayed on screen as "Cancelled" would be the stuck row the reader asked to be rid of. A
 * second entry, "Dismiss all cancelled", does only that part and asks nothing, because nothing is sent.
 *
 * The entry is a plain {@link SessionActionContribution} built by {@link clearStuckMessagesContribution},
 * so any surface that can list a session's sends (this page's menu, a sidebar row's menu) mounts the same
 * one.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { Eraser, EyeOff } from 'lucide-react';
import { useMemo } from 'react';
import { isStuckSend, visibleSettledSends } from '../../lib/ledger-placement.ts';
import { EMPTY_SEND_VIEW, type SendViewState } from '../../lib/send-dismissals.ts';
import type { LedgerSendRecord } from '../../lib/send-ledger.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';

export const CLEAR_STUCK_MESSAGES_ACTION_ID = 'clear-stuck-messages';

/** What the entry needs to know about the ferret the menu is for. */
export interface StuckMessageActionContext {
  readonly canControl: boolean;
}

export const DISMISS_CANCELLED_ACTION_ID = 'dismiss-cancelled-messages';

export const NO_STUCK_MESSAGES_REASON = 'no stuck messages';
export const NO_CANCELLED_MESSAGES_REASON = 'no cancelled messages';

/** The messages the reader can see waiting that nothing proved arrived — dismissed ones are no longer seen. */
export const stuckSends = (
  sends: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
  view: SendViewState = EMPTY_SEND_VIEW,
): LedgerSendRecord[] => sends.filter(record => isStuckSend(record, nowMs) && !view.dismissed.has(record.sendId));

/** Everything "Clear stuck messages" puts away: the stuck ones plus every settled note on screen, once each. */
export const clearableSends = (
  sends: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
  view: SendViewState = EMPTY_SEND_VIEW,
): LedgerSendRecord[] => {
  const stuck = stuckSends(sends, nowMs, view);
  const seen = new Set(stuck.map(record => record.sendId));
  return [...stuck, ...visibleSettledSends(sends, nowMs, view).filter(record => !seen.has(record.sendId))];
};

/** The cancelled notes on screen, which "Dismiss all cancelled" puts away. */
export const cancelledNotes = (
  sends: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
  view: SendViewState = EMPTY_SEND_VIEW,
): LedgerSendRecord[] => visibleSettledSends(sends, nowMs, view).filter(record => record.fate === 'cancelled');

/**
 * Takes back each message in turn — one at a time, because the daemon types into one pane and a second
 * cancel racing the first could read a half-erased composer — and then asks for fresh evidence either
 * way. A refusal does not stop the rest; the failures are reported together at the end, with the
 * daemon's own sentence for the first. `onCancelled` hears of each one the daemon took back, so the caller
 * can put exactly those away.
 */
export const cancelAllStuck = async (
  client: Pick<IFyApiClient, 'cancelSend'> | null,
  sessionId: string,
  stuck: readonly LedgerSendRecord[],
  refresh: () => void,
  onCancelled: (record: LedgerSendRecord) => void = () => undefined,
): Promise<void> => {
  if (client === null) throw new Error('this page is not connected to the machine');
  const failures: string[] = [];
  for (const record of stuck) {
    try {
      await client.cancelSend(sessionId, record.sendId);
      onCancelled(record);
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
        'Ones typed into the agent’s composer are erased from it. Ones the agent is already holding in its own queue are only removed here, so it may still read them. Cancelled ones are just put away.',
      confirmLabel: 'Clear messages',
      run: clear,
    };
  },
});

export const dismissCancelledContribution = (
  cancelled: readonly LedgerSendRecord[],
  dismiss: () => void,
): SessionActionContribution<StuckMessageActionContext> => ({
  group: 'session',
  order: 41,
  build: () => ({
    kind: 'run',
    id: DISMISS_CANCELLED_ACTION_ID,
    label: 'Dismiss all cancelled',
    icon: EyeOff,
    ...(cancelled.length === 0 ? { unavailable: NO_CANCELLED_MESSAGES_REASON } : { detail: String(cancelled.length) }),
    run: dismiss,
  }),
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
  view,
  dismiss,
}: {
  readonly client: Pick<IFyApiClient, 'cancelSend'> | null;
  readonly sessionId: string;
  readonly sends: readonly LedgerSendRecord[];
  readonly refresh: () => void;
  /** What this device has dismissed or opened (`send-dismissals.ts`). */
  readonly view: SendViewState;
  /** Puts these sends away on this device. */
  readonly dismiss: (sendIds: readonly string[]) => void;
}): StuckMessageActions {
  const stuck = useMemo(() => stuckSends(sends, Date.now(), view), [sends, view]);
  const clearable = useMemo(() => clearableSends(sends, Date.now(), view), [sends, view]);
  const cancelled = useMemo(() => cancelledNotes(sends, Date.now(), view), [sends, view]);
  const contributions = useMemo(() => {
    const clear = async (): Promise<void> => {
      dismiss(cancelled.map(record => record.sendId));
      await cancelAllStuck(client, sessionId, stuck, refresh, record => dismiss([record.sendId]));
    };
    return [
      clearStuckMessagesContribution(clearable, clear),
      dismissCancelledContribution(cancelled, () => dismiss(cancelled.map(record => record.sendId))),
    ];
  }, [cancelled, clearable, client, dismiss, refresh, sessionId, stuck]);
  return { contributions, count: clearable.length };
}
