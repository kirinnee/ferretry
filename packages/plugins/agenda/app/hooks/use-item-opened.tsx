/**
 * WHAT AGENDA DOES WHEN THE OWNER OPENS AN ASK: it tells the `agenda.item-opened` hook (Access provides it: this
 * device's alert lines for the ask come down) with the machine's seen mark in hand, and posts nothing itself. With no
 * provider the open is simply not announced, as it was before alerts existed.
 *
 * THE MACHINE IS THE OPENED CARD'S, never the page's: the Inbox lists every machine's cards, and a card of machine B
 * opened on a page of machine A must reach B's provider (B's registration, B's alert lines) and be marked seen through
 * B's own client. A hook is read for one daemon at a time, so an open mounts {@link ItemOpenedAnnounce} for the card's
 * daemon; it reads that daemon's hook and makes the one announcement. A machine this device holds no client for is
 * not announced to at all: nothing is ever sent to the page's machine instead.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AGENDA_ITEM_OPENED_HOOK, isAgendaItemOpened } from '../../contract/app-hooks.ts';
import type { AgendaCall } from '../lib/agenda-call.ts';
import type { AgendaFleet } from '../lib/agenda-fleet.ts';
import { seenMarkOf } from '../lib/agenda-seen.ts';
import type { DaemonId } from '../lib/machine.ts';
import { useAppHook } from '../shell.ts';

/** One open: the machine of the opened card, its ferret's board id and the ask. */
interface Opened {
  readonly daemon: DaemonId;
  readonly ferret: string;
  readonly ask: string;
  readonly client: AgendaCall;
  /** Each open is its own announcement, even of the same ask twice. */
  readonly nth: number;
}

/** Announces one open to the provider on the card's own machine, once, and never rejects. */
function ItemOpenedAnnounce({ opened }: { readonly opened: Opened }): null {
  const provided = useAppHook(opened.daemon, AGENDA_ITEM_OPENED_HOOK);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one announcement per open (this component is keyed by it); a provider that arrives later is not told of an open already past.
  useEffect(() => {
    if (!isAgendaItemOpened(provided)) return;
    // A failed announcement only leaves an alert up; nothing here waits on it.
    void provided(opened.ferret, opened.ask, seenMarkOf(opened.client, opened.ferret, opened.ask)).catch(
      () => undefined,
    );
  }, []);
  return null;
}

/**
 * `onOpened(daemon, ferret, ask)` for the opened card's machine, and `host`, which the page draws once. `page` is the
 * page's own machine and client; every other machine is reached through the fleet's client for it.
 */
export const useItemOpened = (
  page: { readonly daemon: DaemonId; readonly client: AgendaCall },
  fleet?: AgendaFleet,
): { readonly onOpened: (daemon: DaemonId, ferret: string, ask: string) => void; readonly host: ReactNode } => {
  const [opened, setOpened] = useState<Opened | null>(null);
  const onOpened = useCallback(
    (daemon: DaemonId, ferret: string, ask: string) => {
      const client = daemon === page.daemon ? page.client : fleet?.clientOf(daemon);
      if (client === undefined) return;
      setOpened(previous => ({ daemon, ferret, ask, client, nth: (previous?.nth ?? 0) + 1 }));
    },
    [page.daemon, page.client, fleet],
  );
  return { onOpened, host: opened === null ? null : <ItemOpenedAnnounce key={opened.nth} opened={opened} /> };
};
