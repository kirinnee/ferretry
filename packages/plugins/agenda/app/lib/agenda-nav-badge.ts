/**
 * THE INBOX DOOR'S COUNT (`shell.navBadges.agenda`, S4): this machine's share of the number on the Agenda nav entry.
 * The shell builds one per paired, unlocked daemon over its background client and draws the SUM.
 *
 * It is the Inbox page's own number, not a second rule: the machine's conversations, the boards this device holds of
 * them, the machine's own ledger, notifications, items in discussion, the rule suggestions the owner answered and the
 * answers still in their undo window are all derived by `deriveInbox` (`inbox-count.ts`), the function the page
 * counts with. What the page reads to count, the badge reads too — a conversation's board when its summary moves, the
 * machine's ledger — and only once the shell subscribes; the last unsubscribe stops watching: the badge's own runtime
 * lets go of its transport events and queued reads, so nothing reads for a badge nobody is listening to.
 */

import type { FerretsNeedsYou } from '@ferretry/core-ferrets/contract';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { suggestionsKey, sweepAnsweredSuggestions } from '../hooks/use-answered-suggestion-sweep.ts';
import { ruleClientOf } from './rule-client.ts';
import { type AgendaRuntime, createAgendaRuntime, type RuntimeClient } from './agenda-runtime.ts';
import { browserDeferredTimers, type DeferredTimers } from './agenda-inbox.ts';
import { answeredSuggestions } from './answered-suggestions.ts';
import { boardWants, deriveInbox } from './inbox-count.ts';
import { InboxBoardReads } from './inbox-board-reads.ts';
import { type InboxLocal, inboxLocal } from './inbox-local.ts';
import { daemonSessionKey, daemonSessionScope } from './machine.ts';
import { createNeedsYou } from './needs-you-hook.ts';

/** The shape the shell takes (`NavBadge`): this machine's share, and a way to hear it change. */
export interface InboxBadge {
  readonly count: () => number;
  readonly subscribe: (changed: () => void) => () => void;
}

/** What the badge reads besides the machine: the clock its board reads retry on, and what this device did locally. */
export interface InboxBadgeSeams {
  readonly timers?: DeferredTimers;
  readonly local?: InboxLocal;
}

export const inboxBadgeOf = (client: RuntimeClient, seams: InboxBadgeSeams = {}): InboxBadge => {
  const local = seams.local ?? inboxLocal;
  const listeners = new Set<() => void>();
  let runtime: AgendaRuntime | undefined;
  let stop: (() => void) | undefined;

  const derive = (machine: AgendaRuntime) => {
    const boards = machine.agenda.store.getSnapshot().snapshots;
    const { connection } = machine;
    return deriveInbox(
      [
        {
          connection,
          name: machine.name,
          sessions: machine.ferrets.getSnapshot().daemons.get(connection.daemonId)?.sessions ?? null,
        },
      ],
      (daemonId, sessionId) => boards.get(daemonSessionKey({ daemonId, sessionId })),
      {
        hidden: local.getSnapshot().hidden,
        replied: local.getSnapshot().replied,
        answered: answeredSuggestions.getSnapshot(),
      },
    );
  };

  const start = (): (() => void) => {
    // The badge OWNS this runtime for as long as someone listens: its transport events and queued reads end with the
    // last unsubscribe, and a new subscription builds a fresh one.
    const machine = createAgendaRuntime(client);
    runtime = machine;
    const reads = new InboxBoardReads(seams.timers ?? browserDeferredTimers);
    const connection = machine.connection;
    const connectionFor = () => connection;
    // A rule suggestion the owner answered elsewhere leaves the count as it leaves the page: the same sweep, read once
    // per change of the suggestions the deck holds.
    let swept = '[]';
    let cancelSweep: (() => void) | undefined;
    const changed = (): void => {
      const derived = derive(machine);
      reads.sync(boardWants(derived.unread, connectionFor, machine.agenda));
      const key = suggestionsKey(derived.cards);
      if (key !== swept) {
        swept = key;
        cancelSweep?.();
        cancelSweep = sweepAnsweredSuggestions(derived.cards, connectionFor, async () => ruleClientOf(machine.client));
      }
      for (const listener of [...listeners]) listener();
    };
    const stops = [
      machine.ferrets.subscribe(changed),
      machine.agenda.store.subscribe(changed),
      local.subscribe(changed),
      answeredSuggestions.subscribe(changed),
    ];
    machine.agenda.hydrate(connection, daemonSessionScope(connection, MACHINE_AGENDA_ID)).catch(() => undefined);
    changed();
    return () => {
      for (const off of stops) off();
      cancelSweep?.();
      reads.dispose();
      machine.dispose();
      runtime = undefined;
    };
  };

  return {
    count: () => (runtime === undefined ? 0 : derive(runtime).total),
    subscribe: listener => {
      listeners.add(listener);
      if (listeners.size === 1) stop = start();
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stop?.();
        stop = undefined;
      };
    },
  };
};

const SHARED = new WeakMap<object, FerretsNeedsYou>();

/**
 * One machine's needs-you value, made once per client: Ferrets' list (`ferrets.needs-you`) reads it. It is the
 * ferrets' roll-up, not the Inbox's count (`inboxBadgeOf`).
 */
export const needsYouOf = (client: Parameters<typeof createNeedsYou>[0]): FerretsNeedsYou => {
  const known = SHARED.get(client);
  if (known !== undefined) return known;
  const made = createNeedsYou(client);
  SHARED.set(client, made);
  return made;
};
