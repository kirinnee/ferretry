/**
 * THE OWNER OPENED AN AGENDA ITEM HERE, so its alerts come down — on this device at once, and on their other devices
 * through the daemon (docs/notifications.md § When an alert is cleared).
 *
 * This device closes its own lines itself: the daemon's clear skips the device that opened the item, because on an
 * iPhone a clear swaps a line for "Handled on another device", which would be false on the phone in the owner's hand.
 * The item's own tag is closed straight away, before the daemon answers; the tags the daemon's answer
 * names (the ferret's stop line once nothing else waits, an approval's own) are closed when it answers — only the lines
 * shown by the moment of the open (`closeShownTags`' `shownBy`), so a slow answer never takes a newer line down.
 *
 * Best effort and total: a browser with no push worker for the machine, or a failed call, only leaves the lines up.
 */

import { agendaItemPushTag, type PushSeenResponse } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type ClearRegistration, closeShownTags } from './push-clear.ts';
import { pushScopePath } from './push-scope.ts';

export interface AgendaItemOpenedPorts {
  /** This browser's push registration for one machine, or `null` when it has none. */
  readonly registration: (daemon: DaemonId) => Promise<Pick<ClearRegistration, 'getNotifications'> | null>;
  /** Says the item was opened: `postAgendaItemSeen` over the app’s daemon fetch. */
  readonly seen: (daemon: DaemonConnection, sessionId: string, agendaId: string) => Promise<PushSeenResponse>;
  /** The page's clock: the moment of the open, which the daemon's answer may close lines up to. */
  readonly now?: () => number;
}

/** What opening one item did: how many lines it closed here, and whether the daemon was told. */
export interface AgendaItemOpened {
  readonly closed: number;
  readonly told: boolean;
}

/**
 * The handler the Inbox and a conversation call each time an item's card comes up (once per item shown). Opening the same
 * item again tells the machine again: it may have buzzed since (woken from a snooze), and a clear with nothing left to
 * cover sends nothing.
 */
export const agendaItemOpenedHandler = (
  ports: AgendaItemOpenedPorts,
): ((daemon: DaemonConnection, sessionId: string, agendaId: string) => Promise<AgendaItemOpened>) => {
  return async (daemon, sessionId, agendaId) => {
    // Captured at the open, not at the answer: a line shown after it is newer than anything this open saw.
    const openedAt = (ports.now ?? Date.now)();
    const machine = { daemonId: daemon.daemonId, label: daemon.daemonId };
    const registration = await ports.registration(daemon.daemonId).catch(() => null);
    const close = async (tags: readonly string[], shownBy?: number): Promise<number> =>
      registration === null ? 0 : await closeShownTags(registration, tags, machine, shownBy).catch(() => 0);
    let closed = await close([agendaItemPushTag(sessionId, agendaId)]);
    try {
      const answer = await ports.seen(daemon, sessionId, agendaId);
      closed += await close(answer.tags, openedAt);
      // The item's OWN lines go however new: any is about the item open in front of the owner, and one of its pushes
      // may have landed here after the open, which the machine's clear skipped (review round 8).
      closed += await close([agendaItemPushTag(sessionId, agendaId)]);
      return { closed, told: true };
    } catch {
      return { closed, told: false };
    }
  };
};

/** The slice of a service-worker container the page reads one machine's registration from. */
interface PushRegistrationContainer {
  getRegistration(
    clientUrl: string,
  ): Promise<(Pick<ClearRegistration, 'getNotifications'> & { readonly scope: string }) | undefined>;
}

/** The slice of `navigator` that may hold one; a browser without service workers has none. */
export interface PushNavigator {
  readonly serviceWorker?: PushRegistrationContainer | undefined;
}

/**
 * This browser's push registration for one machine (`/push/<daemonId>/`), or `null`: no container, or no registration of
 * that machine's own — the app-wide one, which a lookup by URL falls back to, holds none of its lines.
 */
export const machinePushRegistration =
  (browser: PushNavigator | undefined, origin: string) =>
  async (daemon: DaemonId): Promise<Pick<ClearRegistration, 'getNotifications'> | null> => {
    const container = browser?.serviceWorker;
    if (container === undefined) return null;
    const scope = new URL(pushScopePath(daemon), origin).href;
    const found = await container.getRegistration(scope);
    return found?.scope === scope ? found : null;
  };
