/**
 * A fake Attention inbox for render tests: real `DeferredAttentionActions` on a hand-cranked clock, and
 * the cards the shell would deal — minus whatever is held or in flight — so an answer leaves the deck,
 * an undo brings it back, and nothing is "sent" until the test turns the clock past the window.
 */

import type { AttentionAsk, AttentionItem, SessionView } from '@ferretry/protocol';
import { type ReactElement, useSyncExternalStore } from 'react';
import type { AttentionInbox } from '../../src/hooks/use-attention-inbox.ts';
import {
  DeferredAttentionActions,
  type DeferredTimers,
  type InboxAction,
  type InboxCard,
  inboxCardKey,
} from '../../src/lib/attention-inbox.ts';
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

export const attentionItem = (id: string, overrides: Partial<AttentionItem> = {}): AttentionItem =>
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
  }) as AttentionItem;

export const choices = (...labels: string[]): AttentionAsk =>
  ({ kind: 'multiple-choice', options: labels.map(label => ({ label })) }) as AttentionAsk;

export const inboxCard = (
  item: AttentionItem,
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
  readonly deferred: DeferredAttentionActions;
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
    deferred: new DeferredAttentionActions(async (card, action) => {
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
  render,
}: {
  readonly fake: FakeInbox;
  readonly cards: readonly InboxCard[];
  readonly reading?: boolean;
  readonly render: (inbox: AttentionInbox) => ReactElement;
}) {
  const state = useSyncExternalStore(fake.deferred.subscribe, fake.deferred.getSnapshot);
  const hidden = new Set([...state.pending.map(entry => entry.key), ...state.sending]);
  const inbox: AttentionInbox = {
    unread: [],
    total: cards.length,
    cards: cards.filter(card => !hidden.has(card.key)),
    reading,
    deferred: fake.deferred,
    deferredState: state,
    connectionFor: () => undefined,
  };
  return render(inbox);
}
