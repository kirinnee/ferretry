/**
 * WHAT AGENDA DOES WHEN THE OWNER OPENS AN ASK: it tells the `agenda.item-opened` hook (Access provides it: this
 * device's alert lines for the ask come down) with the machine's seen mark in hand, and posts nothing itself. With no
 * provider the open is simply not announced, as it was before alerts existed.
 */

import { useCallback } from 'react';
import { AGENDA_ITEM_OPENED_HOOK, isAgendaItemOpened } from '../../contract/app-hooks.ts';
import type { AgendaCall } from '../lib/agenda-call.ts';
import { seenMarkOf } from '../lib/agenda-seen.ts';
import type { DaemonId } from '../lib/machine.ts';
import { useAppHook } from '../shell.ts';

/** Announces one opened ask (its ferret's board id and the ask id) to the provider for `daemon`. Never rejects. */
export const useItemOpened = (daemon: DaemonId, client: AgendaCall): ((ferret: string, ask: string) => void) => {
  const provided = useAppHook(daemon, AGENDA_ITEM_OPENED_HOOK);
  return useCallback(
    (ferret, ask) => {
      if (!isAgendaItemOpened(provided)) return;
      // A failed announcement only leaves an alert up; nothing here waits on it.
      void provided(ferret, ask, seenMarkOf(client, ferret, ask)).catch(() => undefined);
    },
    [provided, client],
  );
};
