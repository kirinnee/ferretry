/**
 * THE INBOX, DERIVED ONCE: from the machines' conversations, the boards this device holds and what it has done locally
 * to them, the conversations that need the owner (`unread`), the deck (`cards`) and the Inbox count (`total`). The
 * Inbox page (`hooks/use-agenda-inbox.ts`) and the Agenda nav count (`agenda-nav-badge.ts`) both read it here, so there
 * is no second rule for what an Inbox item is: a machine's own notices, plain notifications, items in discussion, a rule
 * suggestion the owner already answered and an answer still in its undo window are all decided in one place.
 */

import type { AgendaListSnapshot } from '@ferretry/core-asks/contract';
import type { DaemonAgendaClient } from './agenda-client.ts';
import {
  agendaSummaryKey,
  type InboxCard,
  inboxCards,
  inboxCount,
  type UnreadSession,
  unreadSessions,
} from './agenda-inbox.ts';
import { type RepliedState, withRepliedCards } from './agenda-replied.ts';
import { answeredSuggestions } from './answered-suggestions.ts';
import type { InboxBoardWant } from './inbox-board-reads.ts';
import { withMachineAgendas } from './machine-agenda.ts';
import { type DaemonConnection, type DaemonId, daemonSessionKey, daemonSessionScope } from './machine.ts';
import { isMachineAgendaId } from '@ferretry/core-asks/contract';
import type { SessionView } from '../shell.ts';

/** One machine as the Inbox reads it. `sessions` is `null` before its list was first read. */
export interface InboxMachine {
  readonly connection: Pick<DaemonConnection, 'daemonId'>;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

/** What this device did to the Inbox that the boards do not say yet. */
export interface InboxLocalView {
  /** Keys of answers inside their undo window or in flight. */
  readonly hidden: ReadonlySet<string>;
  /** The owner's "answered" set for standing-rule suggestions (`answered-suggestions.ts`). */
  readonly answered: ReadonlySet<string>;
  readonly replied: RepliedState;
}

export type BoardFor = (daemonId: DaemonId, sessionId: string) => AgendaListSnapshot | undefined;

/** The deck before a just-sent reply is overlaid: owner-turn items of the unread conversations, answered suggestions out. */
const boardDeck = (
  unread: readonly UnreadSession[],
  boardFor: BoardFor,
  local: Pick<InboxLocalView, 'hidden' | 'answered'>,
): readonly InboxCard[] =>
  inboxCards(unread, boardFor, local.hidden).filter(card => {
    const suggestion = card.item.signInRuleSuggestion?.suggestion;
    return suggestion === undefined || !answeredSuggestions.has(local.answered, card.daemonId, suggestion);
  });

export interface InboxDerived {
  readonly unread: readonly UnreadSession[];
  /** The deck as the boards say it (no reply overlay): what a reply's overlay is reconciled against. */
  readonly boardCards: readonly InboxCard[];
  /** The deck the owner sees. */
  readonly cards: readonly InboxCard[];
  /** THE INBOX COUNT (`inboxCount`). */
  readonly total: number;
}

/**
 * The reply overlay is the whole device's (`inboxLocal`), but a derivation counts only the machines it is given: a
 * card Undo brought back belongs to ITS machine, so another machine's badge, or a locked or unpaired machine, must
 * not add it. One machine's cards are the ones whose `daemonId` is among `machines`.
 */
const repliedWithin = (machines: readonly InboxMachine[], replied: RepliedState): RepliedState => {
  const mine = new Set<DaemonId>(machines.map(machine => machine.connection.daemonId));
  const entries = replied.entries.filter(entry => mine.has(entry.card.daemonId));
  return entries.length === replied.entries.length ? replied : { ...replied, entries };
};

export const deriveInbox = (
  machines: readonly InboxMachine[],
  boardFor: BoardFor,
  local: InboxLocalView,
): InboxDerived => {
  const unread = unreadSessions(
    withMachineAgendas(machines, boardFor).map(machine => ({
      daemonId: machine.connection.daemonId,
      name: machine.name,
      sessions: machine.sessions,
    })),
  );
  const boardTasks = boardDeck(unread, boardFor, local);
  const cards = withRepliedCards(boardTasks, repliedWithin(machines, local.replied));
  const held = (entry: UnreadSession): boolean => boardFor(entry.daemonId, entry.view.config.id) !== undefined;
  return { unread, boardCards: boardTasks, cards, total: inboxCount(unread, held, cards) };
};

/**
 * The boards the Inbox keeps held for `entries`: one per conversation, read again when its summary moves. The machine's
 * own ledger is hydrated; a conversation's board is revalidated.
 */
export const boardWants = (
  entries: readonly UnreadSession[],
  connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined,
  client: DaemonAgendaClient,
): readonly InboxBoardWant[] =>
  entries.flatMap(entry => {
    const connection = connectionFor(entry.daemonId);
    if (connection === undefined) return [];
    const scope = daemonSessionScope(connection, entry.view.config.id);
    return [
      {
        id: daemonSessionKey(scope),
        key: agendaSummaryKey(entry.attention),
        // The fleet stream owns machine-board freshness; rendering its held board needs no refresh.
        read: () =>
          isMachineAgendaId(scope.sessionId) ? client.hydrate(connection, scope) : client.revalidate(connection, scope),
        held: () => client.store.agenda(scope) !== undefined,
      },
    ];
  });
