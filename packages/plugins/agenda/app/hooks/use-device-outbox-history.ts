/**
 * THE OWNER'S WORDS STILL ON THIS DEVICE, as History events for one item: Conversation's `conversation.device-outbox`
 * (read only), narrowed with Conversation's own guard, filtered to the messages about the item. A missing hook, a second
 * provider or a value of another shape is no outbox: the History then draws as it always did.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import {
  CONVERSATION_DEVICE_OUTBOX_HOOK,
  CONVERSATION_PROVIDED_APP_HOOKS,
  type DeviceOutboxEntry,
} from '@ferretry/plugin-conversation/contract';
import { deviceEvents, type HistoryEvent } from '../lib/agenda-history.ts';
import { useAppHook } from '../shell.ts';

const NONE: readonly HistoryEvent[] = Object.freeze([]);
const NO_ENTRIES: readonly DeviceOutboxEntry[] = Object.freeze([]);
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** The ferret the item is on, on the machine it is on: absent where the host does not know one. */
export interface DeviceOutboxScope {
  readonly daemonId: string;
  readonly sessionId: string;
}

export const useDeviceOutboxHistory = (
  scope: DeviceOutboxScope | null | undefined,
  item: AgendaItem['id'],
): readonly HistoryEvent[] => {
  const provided = useAppHook(scope?.daemonId, CONVERSATION_DEVICE_OUTBOX_HOOK, 'conversation');
  const outbox = CONVERSATION_PROVIDED_APP_HOOKS[CONVERSATION_DEVICE_OUTBOX_HOOK](provided) ? provided : undefined;
  const sessionId = scope?.sessionId;
  const entries = useSyncExternalStore(outbox?.subscribe ?? NO_SUBSCRIPTION, () =>
    outbox === undefined || sessionId === undefined ? NO_ENTRIES : outbox.entries(sessionId),
  );
  return useMemo(() => (entries.length === 0 ? NONE : deviceEvents(item, entries)), [entries, item]);
};
