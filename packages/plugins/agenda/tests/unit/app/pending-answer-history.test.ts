import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { itemHistory, withDeviceEvents } from '../../../app/lib/agenda-history.ts';
import {
  DeferredAgendaActions,
  type DeferredTimers,
  type InboxCard,
  inboxCardKey,
  UNDO_WINDOW_MS,
} from '../../../app/lib/agenda-inbox.ts';
import type { InboxAction } from '../../../app/lib/agenda-answers.ts';
import { pendingAnswerEvents } from '../../../app/lib/pending-answer-history.ts';
import type { DaemonId } from '../../../app/shell.ts';
import { sessionView } from '../../support/app/sessions.ts';

const STUDIO = 'studio' as DaemonId;
const SHIP: InboxAction = { kind: 'respond', label: 'Ship', response: { kind: 'multiple-choice', choice: 'Ship' } };

const item = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  ({
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Ship the relay fix today?',
    why: 'Because.',
    waitingSince: '2026-10-23T12:00:00.000Z',
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    ask: { kind: 'multiple-choice', options: [{ label: 'Ship' }, { label: 'Hold' }] },
    ...extra,
  }) as AgendaItem;

const card = (shown: AgendaItem = item()): InboxCard => ({
  key: inboxCardKey(STUDIO, 's', shown.id),
  daemonId: STUDIO,
  machineName: 'Studio',
  view: sessionView('s'),
  item: shown,
});

const fakeTimers = () => {
  let clock = 1_000;
  const queue = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const timers: DeferredTimers = {
    setTimeout: (run, milliseconds) => {
      next += 1;
      queue.set(next, { at: clock + milliseconds, run });
      return next;
    },
    clearTimeout: handle => void queue.delete(handle as number),
    now: () => clock,
  };
  const advance = (milliseconds: number): void => {
    clock += milliseconds;
    for (const [handle, timer] of [...queue]) {
      if (timer.at <= clock) {
        queue.delete(handle);
        timer.run();
      }
    }
  };
  return { timers, advance };
};

/** What the item's conversation shows now: the stored history with the inbox's held answers, as the views build it. */
const conversation = (deferred: DeferredAgendaActions, shown: AgendaItem = item()) =>
  withDeviceEvents(itemHistory(shown, []), pendingAnswerEvents(deferred.getSnapshot(), card(shown).key, shown)).flatMap(
    event =>
      event.kind === 'owner'
        ? [{ text: event.text, via: event.reached?.via, refused: event.reached?.outbox?.refused }]
        : [],
  );

describe('an answer in its undo window, in the item conversation', () => {
  test('shows the moment it is given, and Undo takes it out again', () => {
    const { timers } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => undefined, timers);
    expect(conversation(deferred)).toEqual([]);
    deferred.schedule(card(), SHIP);
    expect(conversation(deferred)).toEqual([{ text: 'Ship', via: 'device', refused: false }]);
    deferred.undo();
    expect(conversation(deferred)).toEqual([]);
  });

  test('stays through the send, then leaves once the machine took it and the item carries the answer', async () => {
    const { timers, advance } = fakeTimers();
    let release: () => void = () => undefined;
    const deferred = new DeferredAgendaActions(() => new Promise<void>(resolve => (release = resolve)), timers);
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    expect(deferred.getSnapshot().pending).toEqual([]);
    expect(conversation(deferred)).toEqual([{ text: 'Ship', via: 'device', refused: false }]);
    // The machine's echo arrives before the commit settles: the item holds the answer, so nothing is drawn twice.
    const echoed = item({
      ownerAnswer: {
        at: new Date(1_000 + UNDO_WINDOW_MS).toISOString(),
        response: SHIP.kind === 'respond' ? SHIP.response : undefined,
      },
    } as Partial<AgendaItem>);
    expect(conversation(deferred, echoed)).toEqual([]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(conversation(deferred)).toEqual([]);
  });

  test('a refused answer stays in the conversation as Not sent, with the machine’s reason', async () => {
    const { timers, advance } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => {
      throw new Error('The ask was replaced.');
    }, timers);
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(deferred.getSnapshot().failed).toHaveLength(1);
    expect(conversation(deferred)).toEqual([{ text: 'Ship', via: 'device', refused: true }]);
    deferred.clearFailure(card().key);
    expect(conversation(deferred)).toEqual([]);
  });

  test('is only ever the answer to its own item', () => {
    const { timers } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => undefined, timers);
    deferred.schedule(card(), SHIP);
    expect(pendingAnswerEvents(deferred.getSnapshot(), card(item({ id: 'A2' })).key, item({ id: 'A2' }))).toEqual([]);
  });
});
