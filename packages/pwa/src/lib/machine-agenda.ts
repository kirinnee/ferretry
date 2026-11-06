/**
 * THE MACHINE AGENDA, as the Inbox sees it (docs/agenda.md § The machine agenda): one ledger the DAEMON owns for the
 * notices that belong to no ferret — "3 ferrets could not be moved", "a login hit its hard limit". It has an id no
 * session can have, its own route, and no ferret to talk to: the owner clears or snoozes its items.
 *
 * The Inbox reads it like a conversation's board: a stand-in conversation named "Machine" is listed beside the
 * machine's sessions, so counts, Find, Snoozed and every action work unchanged, and the one thing that differs —
 * where its board and its answers go — is decided by {@link isMachineAgendaId}.
 */

import {
  type AgendaItem,
  type AgendaListSnapshot,
  MACHINE_AGENDA_ID,
  type SessionAgendaSummary,
  type SessionView,
} from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

/** The name the Inbox groups the machine agenda under. */
export const MACHINE_GROUP_NAME = 'Machine';

const instant = (value: string): number => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
};

const summaryOf = (items: readonly AgendaItem[]): SessionAgendaSummary | undefined => {
  const open = items.filter(item => item.parked === undefined);
  const oldest = open.reduce<AgendaItem | undefined>(
    (best, item) => (best === undefined || instant(item.waitingSince) < instant(best.waitingSince) ? item : best),
    undefined,
  );
  if (oldest === undefined) return undefined;
  const latestAt = open.reduce(
    (best, item) => (instant(item.waitingSince) > instant(best) ? item.waitingSince : best),
    oldest.waitingSince,
  );
  return { open: open.length, first: oldest.id, ask: oldest.subject, latestAt };
};

/**
 * The stand-in conversation for a machine's agenda board: only the fields the Inbox reads of a conversation are
 * real. A board with nothing in it (open, parked or resolved) has none — the machine shows no group.
 */
export const machineSessionView = (snapshot: AgendaListSnapshot): SessionView | undefined => {
  if (snapshot.items.length === 0 && snapshot.resolved.length === 0) return undefined;
  const summary = summaryOf(snapshot.items);
  return {
    config: {
      id: MACHINE_AGENDA_ID,
      name: MACHINE_GROUP_NAME,
      mode: 'auto',
      cwd: '',
      createdAt: snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
    },
    state: {
      id: MACHINE_AGENDA_ID,
      status: 'running',
      turn: 0,
      lastActivityAt: snapshot.updatedAt,
      ...(summary === undefined ? {} : { agenda: summary }),
    },
    directory: '',
  } as unknown as SessionView;
};

/** `machines` with each one's agenda listed first among its conversations, when it has something on it. */
export const withMachineAgendas = <
  M extends {
    readonly connection: Pick<DaemonConnection, 'daemonId'>;
    readonly sessions: readonly SessionView[] | null;
  },
>(
  machines: readonly M[],
  boardFor: (daemonId: DaemonId, sessionId: string) => AgendaListSnapshot | undefined,
): readonly M[] =>
  machines.map(machine => {
    const board = boardFor(machine.connection.daemonId, MACHINE_AGENDA_ID);
    const view = board === undefined ? undefined : machineSessionView(board);
    return view === undefined ? machine : { ...machine, sessions: [view, ...(machine.sessions ?? [])] };
  });
