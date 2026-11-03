/**
 * THE OWNER OPENED AN AGENDA ITEM HERE, so its alerts come down — on this device at once, and on their other devices
 * through the daemon (docs/notifications.md § When an alert is cleared).
 *
 * This device closes its own lines itself: the daemon's clear skips the device that opened the item, because on an
 * iPhone a clear swaps a line for "Handled on another device", which would be false on the phone in the owner's hand.
 * The item's own tag is closed straight away, even on a daemon too old to clear anything; the tags the daemon's answer
 * names (the ferret's stop line once nothing else waits, an approval's own) are closed when it answers.
 *
 * Best effort and total: a browser with no push worker for the machine, a daemon that does not list `push.clear.1`, or
 * a failed call only leaves the lines up, which is how it was before.
 */

import { agendaItemPushTag, DAEMON_FEATURES, hasFeature, type PushSeenResponse } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type ClearRegistration, closeShownTags } from './push-clear.ts';

export interface AgendaItemOpenedPorts {
  /** This browser's push registration for one machine, or `null` when it has none. */
  readonly registration: (daemon: DaemonId) => Promise<Pick<ClearRegistration, 'getNotifications'> | null>;
  /** The machine's health, for whether it lists `push.clear.1`. */
  readonly health: (daemon: DaemonConnection) => Promise<{ readonly features?: readonly string[] | undefined }>;
  /** Says the item was opened: `postAgendaItemSeen` over the app’s daemon fetch. */
  readonly seen: (daemon: DaemonConnection, sessionId: string, agendaId: string) => Promise<PushSeenResponse>;
}

/** What opening one item did: how many lines it closed here, and whether the daemon was told. */
export interface AgendaItemOpened {
  readonly closed: number;
  readonly told: boolean;
}

/**
 * The handler the Inbox calls each time it opens an item. Each item is told once per page life: opening it again
 * changes nothing the first time did not.
 */
export const agendaItemOpenedHandler = (
  ports: AgendaItemOpenedPorts,
): ((daemon: DaemonConnection, sessionId: string, agendaId: string) => Promise<AgendaItemOpened>) => {
  const told = new Set<string>();
  return async (daemon, sessionId, agendaId) => {
    const key = `${daemon.daemonId}\u0000${sessionId}\u0000${agendaId}`;
    if (told.has(key)) return { closed: 0, told: false };
    told.add(key);
    const machine = { daemonId: daemon.daemonId, label: daemon.daemonId };
    const registration = await ports.registration(daemon.daemonId).catch(() => null);
    const close = async (tags: readonly string[]): Promise<number> =>
      registration === null ? 0 : await closeShownTags(registration, tags, machine).catch(() => 0);
    let closed = await close([agendaItemPushTag(sessionId, agendaId)]);
    try {
      if (!hasFeature(await ports.health(daemon), DAEMON_FEATURES.pushClear)) return { closed, told: false };
      const answer = await ports.seen(daemon, sessionId, agendaId);
      closed += await close(answer.tags);
      return { closed, told: true };
    } catch {
      return { closed, told: false };
    }
  };
};
