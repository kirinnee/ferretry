/**
 * Conversation's side of `conversation.device-outbox`: this device's unsent owner messages for one ferret, read only.
 *
 * It is a window over the daemon's document outbox (`documentOutbox`): `subscribe` is the outbox's own, and `entries`
 * narrows its snapshot to one ferret and to the few fields the contract names. Nothing is written through it, and the
 * files and shared-draft data an entry carries never leave this module.
 */

import type { ConversationDeviceOutbox, DeviceOutboxEntry } from '../../contract/app-hooks.ts';
import type { OutboxEntry, SendOutbox } from './send-outbox.ts';
import { documentOutbox } from './send-outbox-wiring.ts';

const NONE: readonly DeviceOutboxEntry[] = Object.freeze([]);

/** The words and receipt facts of one entry, and nothing else. */
const project = (entry: OutboxEntry): DeviceOutboxEntry =>
  Object.freeze({
    id: entry.id,
    ferretId: entry.ferretId,
    message: entry.message,
    references: Object.freeze([...(entry.references ?? [])]),
    createdAt: entry.createdAt,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.refused === true ? { refused: true as const } : {}),
  });

/**
 * The hook for one daemon. `outbox` is the document's own for `daemon` unless a test hands one in.
 *
 * Each ferret's array is kept until its entries change (by identity, which is what the outbox's snapshot gives), so a
 * `useSyncExternalStore` reader sees a stable value between changes.
 */
export function deviceOutboxFor(
  daemon: string,
  outbox: SendOutbox = documentOutbox(daemon).outbox,
): ConversationDeviceOutbox {
  const kept = new Map<
    string,
    { readonly source: readonly OutboxEntry[]; readonly view: readonly DeviceOutboxEntry[] }
  >();
  return Object.freeze({
    subscribe: outbox.subscribe,
    entries: (ferret: string): readonly DeviceOutboxEntry[] => {
      const source = outbox.entriesFor(daemon, ferret);
      const previous = kept.get(ferret);
      if (
        previous !== undefined &&
        previous.source.length === source.length &&
        previous.source.every((e, i) => e === source[i])
      )
        return previous.view;
      const view = source.length === 0 ? NONE : Object.freeze(source.map(project));
      kept.set(ferret, { source, view });
      return view;
    },
  });
}
