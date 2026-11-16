import { useRef } from 'react';
import { useOptionalRouter } from '../../shell.ts';
import { agendaTargetFromSearch } from '../../lib/agenda-inbox.ts';
import type { AgendaFocus } from './agenda.tsx';

/**
 * The request a link carries to show one ask: `?ask=A3` (`ASK_LINK_PARAMETER`) on the address, which is where a
 * notification tap lands (`/d/<daemon>/ferrets/<ferret>/chat?ask=A3`, or `/d/<daemon>/agenda?ask=A3` for a machine ask).
 * `null` for no `ask`, or one that is not an ask id — a junk link asks for nothing.
 *
 * It arrived WITH the page, so `onEntry` is set: entering shows only what is open, never the resolved list.
 */
export const askFocusFromSearch = (search: string, seq: number): AgendaFocus | null => {
  const target = agendaTargetFromSearch(search);
  return target === null ? null : { target, seq, onEntry: true };
};

/**
 * THE ASK THE ADDRESS ASKS FOR, as the `focus` request the Agenda draws (`AgendaFocus`), read through the app's router.
 *
 * `seq` is new for EVERY navigation (the router's history entry), so a second tap on the same ask — a later
 * notification, or the same link followed again — is a new request and is honoured again; a re-render of the same entry
 * keeps its `seq`, so nothing re-opens by itself. Back to an earlier entry is a navigation too.
 *
 * Without a router (a harness) the address is read once and its `seq` is 1.
 */
export const useAskFocus = (): AgendaFocus | null => {
  const router = useOptionalRouter();
  const entry = router?.entryKey ?? '';
  const counter = useRef({ entry, seq: 1 });
  if (counter.current.entry !== entry) counter.current = { entry, seq: counter.current.seq + 1 };
  return askFocusFromSearch(typeof window === 'undefined' ? '' : window.location.search, counter.current.seq);
};
