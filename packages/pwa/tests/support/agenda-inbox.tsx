/**
 * A fake Agenda inbox for render tests: real `DeferredAgendaActions` on a hand-cranked clock, and
 * the cards the shell would deal — minus whatever is held or in flight — so an answer leaves the deck,
 * an undo brings it back, and nothing is "sent" until the test turns the clock past the window.
 */

import { type AgendaAsk, type AgendaItem, agendaTurn, type SessionView } from '@ferretry/protocol';
import { type ReactElement, useSyncExternalStore } from 'react';
import type { AgendaInbox } from '../../src/hooks/use-agenda-inbox.ts';
import {
  DeferredAgendaActions,
  type DeferredTimers,
  type InboxAction,
  type InboxCard,
  inboxCardKey,
  isOnOwner,
} from '../../src/lib/agenda-inbox.ts';
import { type DaemonId, daemonId } from '../../src/lib/daemon-connection.ts';
import { sessionView } from './sessions.ts';

interface ManualClock extends DeferredTimers {
  /** Runs every timer due within `ms` from now, in order. */
  readonly advance: (ms: number) => void;
}

const manualClock = (start = 1_000_000): ManualClock => {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: handle => {
      timers.delete(handle as number);
    },
    advance: ms => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
};

const MACHINE: DaemonId = daemonId('workshop');

export const agendaItem = (id: string, overrides: Partial<AgendaItem> = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    sourceSeq: 1,
    subject: `Ask ${id}`,
    why: `Why ${id} needs you.`,
    waitingSince: '2026-08-01T11:00:00.000Z',
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'sess-1',
    raisedByName: 'zoe',
    ...overrides,
  }) as AgendaItem;

export const choices = (...labels: string[]): AgendaAsk =>
  ({ kind: 'multiple-choice', options: labels.map(label => ({ label })) }) as AgendaAsk;

export const inboxCard = (
  item: AgendaItem,
  view: SessionView = sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build' } }),
  machineName = 'Workshop',
  daemon: DaemonId = MACHINE,
): InboxCard => ({
  key: inboxCardKey(daemon, view.config.id, item.id),
  daemonId: daemon,
  machineName,
  view,
  item,
});

interface Commit {
  readonly card: InboxCard;
  readonly action: InboxAction;
}

export interface FakeInbox {
  readonly deferred: DeferredAgendaActions;
  readonly clock: ManualClock;
  readonly commits: Commit[];
  /** Makes the next commit fail with this message. */
  failNext: string | null;
}

export const fakeInbox = (): FakeInbox => {
  const clock = manualClock();
  const commits: Commit[] = [];
  const fake: FakeInbox = {
    clock,
    commits,
    failNext: null,
    deferred: new DeferredAgendaActions(async (card, action) => {
      commits.push({ card, action });
      const failure = fake.failNext;
      fake.failNext = null;
      if (failure !== null) throw new Error(failure);
    }, clock),
  };
  return fake;
};

/** Renders `render(inbox)` against a live inbox built from `cards` and the fake's deferral. */
export function InboxHarness({
  fake,
  cards,
  reading = false,
  resolved = [],
  resolvedReading = false,
  parked = [],
  loadResolved = () => undefined,
  toTest = [],
  toTestSnoozed = [],
  render,
}: {
  readonly fake: FakeInbox;
  readonly cards: readonly InboxCard[];
  readonly reading?: boolean;
  readonly resolved?: AgendaInbox['resolved'];
  readonly resolvedReading?: boolean;
  readonly parked?: AgendaInbox['parked'];
  readonly loadResolved?: () => void;
  readonly toTest?: AgendaInbox['toTest'];
  readonly toTestSnoozed?: AgendaInbox['toTestSnoozed'];
  readonly render: (inbox: AgendaInbox) => ReactElement;
}) {
  const state = useSyncExternalStore(fake.deferred.subscribe, fake.deferred.getSnapshot);
  const hidden = new Set([...state.pending.map(entry => entry.key), ...state.sending]);
  const shown = cards.filter(card => !hidden.has(card.key));
  const inbox: AgendaInbox = {
    unread: [],
    total: cards.filter(card => isOnOwner(card.item)).length + toTest.length,
    // Split as the shell splits them: by whose turn the item is on.
    withFerret: shown.filter(card => agendaTurn(card.item) === 'ferret'),
    cards: shown.filter(card => isOnOwner(card.item)),
    reading,
    resolved,
    resolvedReading,
    parked: parked.filter(card => !hidden.has(card.key)),
    loadResolved,
    deferred: fake.deferred,
    deferredState: state,
    connectionFor: () => undefined,
    toTest,
    toTestSnoozed,
  };
  return render(inbox);
}
