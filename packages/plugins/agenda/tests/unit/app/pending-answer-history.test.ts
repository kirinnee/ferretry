import { describe, expect, test } from 'bun:test';
import { type AgendaItem, taskAskReference } from '@ferretry/core-asks/contract';
import { itemHistory, withDeviceEvents } from '../../../app/lib/agenda-history.ts';
import {
  DeferredAgendaActions,
  type DeferredTimers,
  type InboxCard,
  inboxCardKey,
  UNDO_WINDOW_MS,
} from '../../../app/lib/agenda-inbox.ts';
import type { InboxAction } from '../../../app/lib/agenda-answers.ts';
import { AnswerReceipts } from '../../../app/lib/answer-receipts.ts';
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

describe('what the line says of the answer', () => {
  test('carries the owner’s note, and a Done is drawn as done', () => {
    const { timers } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => undefined, timers);
    deferred.schedule(card(), { ...SHIP, note: 'after lunch' });
    deferred.schedule(card(item({ id: 'A3' })), { kind: 'resolve', label: 'Done' });
    deferred.schedule(card(item({ id: 'A4' })), { kind: 'dismiss', label: 'Skip', note: '  ' });
    const events = (id: string) => pendingAnswerEvents(deferred.getSnapshot(), card(item({ id })).key, item({ id }));
    expect(events('A1')).toMatchObject([{ text: 'Ship', form: 'answer', note: 'after lunch' }]);
    expect(events('A3')).toMatchObject([{ text: 'Done', form: 'done' }]);
    const dismissed = events('A4')[0];
    expect(dismissed).toMatchObject({ text: 'Skip' });
    expect(dismissed).not.toHaveProperty('form');
    expect(dismissed).not.toHaveProperty('note');
  });

  test('a snooze is no answer', () => {
    const { timers } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => undefined, timers);
    deferred.schedule(card(), { kind: 'snooze', label: 'Snooze', until: '2026-10-24T09:00:00.000Z' });
    expect(pendingAnswerEvents(deferred.getSnapshot(), card().key, item())).toEqual([]);
  });
});

const HOLD: InboxAction = { kind: 'respond', label: 'Hold', response: { kind: 'multiple-choice', choice: 'Hold' } };
const response = (action: InboxAction) => (action.kind === 'respond' ? action.response : undefined);
const asOwnerAnswer = (action: InboxAction, at: string) =>
  ({ ownerAnswer: { at, response: response(action), request: 1 } }) as Partial<AgendaItem>;

describe('the machine’s echo is told by WHAT it says and to WHICH ask, never by a clock', () => {
  const sending = () => {
    const { timers, advance } = fakeTimers();
    const deferred = new DeferredAgendaActions(() => new Promise<void>(() => undefined), timers);
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    return deferred;
  };

  test('another answer stamped in the machine’s future does not hide the Ship still waiting to be sent', () => {
    const deferred = sending();
    const elsewhere = item(asOwnerAnswer(HOLD, '2030-01-01T00:00:00.000Z'));
    expect(conversation(deferred, elsewhere)).toEqual([{ text: 'Ship', via: 'device', refused: false }]);
  });

  test('a refusal is not hidden by another answer stamped later than this device’s clock', async () => {
    const { timers, advance } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => {
      throw new Error('The ask was replaced.');
    }, timers);
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    await Promise.resolve();
    await Promise.resolve();
    const elsewhere = item(asOwnerAnswer(HOLD, '2030-01-01T00:00:00.000Z'));
    expect(conversation(deferred, elsewhere)).toEqual([{ text: 'Ship', via: 'device', refused: true }]);
  });

  test('the matching echo, stamped a millisecond BEFORE the answer was given on this device, is drawn once — by the item', () => {
    const deferred = sending();
    const echoed = item(asOwnerAnswer(SHIP, new Date(1_000 - 1).toISOString()));
    expect(conversation(deferred, echoed)).toEqual([]);
  });

  test('a recorded Ship never hides a separately refused Ship to the same ask', async () => {
    const { timers, advance } = fakeTimers();
    const deferred = new DeferredAgendaActions(async () => {
      throw new Error('Offline');
    }, timers);
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(conversation(deferred, item(asOwnerAnswer(SHIP, new Date(999).toISOString())))).toEqual([
      { text: 'Ship', via: 'device', refused: true },
    ]);
  });

  test('the matching echo, stamped long before this device’s clock, is still the echo', () => {
    const deferred = sending();
    expect(conversation(deferred, item(asOwnerAnswer(SHIP, '2020-01-01T00:00:00.000Z')))).toEqual([]);
  });

  test('the same words to an ask the ferret has since replaced are not this answer’s echo', () => {
    const deferred = sending();
    const replaced = item({ ...asOwnerAnswer(SHIP, '2026-10-23T12:00:00.000Z'), askVersion: 2 } as Partial<AgendaItem>);
    expect(conversation(deferred, replaced)).toEqual([{ text: 'Ship', via: 'device', refused: false }]);
  });

  test('a task ask’s echo is that ask’s own answer, found by its reference', () => {
    const { timers, advance } = fakeTimers();
    const gate = {
      cardId: 'F12',
      laneId: 'verify',
      entry: 1,
      options: [{ label: 'Ship' }, { label: 'Hold' }],
    };
    const ask = (answer: InboxAction) =>
      ({
        gate,
        at: '2026-10-23T12:00:00.000Z',
        answer: { at: '2020-01-01T00:00:00.000Z', response: response(answer), receipt: 'a'.repeat(64) },
      }) as never;
    const reference = taskAskReference(ask(SHIP));
    const deferred = new DeferredAgendaActions(() => new Promise<void>(() => undefined), timers);
    deferred.schedule(card(), { ...SHIP, gate: true, cardAsk: reference } as InboxAction);
    advance(UNDO_WINDOW_MS);
    expect(conversation(deferred, item({ cardAsks: [ask(SHIP)] } as Partial<AgendaItem>))).toEqual([]);
    expect(conversation(deferred, item({ cardAsks: [ask(HOLD)] } as Partial<AgendaItem>))).toEqual([
      { text: 'Ship', via: 'device', refused: false },
    ]);
  });
});

describe('a receipt is per SEND, so settling one never takes another’s', () => {
  const settled = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const twoSends = () => {
    const { timers, advance } = fakeTimers();
    const commits: { resolve: () => void; reject: (reason: Error) => void }[] = [];
    const deferred = new DeferredAgendaActions(
      () => new Promise<void>((resolve, reject) => commits.push({ resolve, reject })),
      timers,
    );
    deferred.schedule(card(), SHIP);
    advance(UNDO_WINDOW_MS);
    deferred.schedule(card(), HOLD);
    advance(UNDO_WINDOW_MS);
    return { deferred, commits };
  };
  const sent = (deferred: DeferredAgendaActions) => deferred.getSnapshot().sending.map(entry => entry.action.label);

  test('the first send settling leaves the second still on its way, and still drawn', async () => {
    const { deferred, commits } = twoSends();
    expect(sent(deferred)).toEqual(['Ship', 'Hold']);
    commits[0]?.resolve();
    await settled();
    expect(sent(deferred)).toEqual(['Hold']);
    expect([...deferred.hiddenKeys()]).toEqual([card().key]);
    expect(conversation(deferred)).toEqual([{ text: 'Hold', via: 'device', refused: false }]);
  });

  test('the second settling first leaves the first', async () => {
    const { deferred, commits } = twoSends();
    commits[1]?.resolve();
    await settled();
    expect(sent(deferred)).toEqual(['Ship']);
  });

  test('rejecting Hold then the older Ship keeps both independent failures and reasons', async () => {
    const { deferred, commits } = twoSends();
    commits[1]?.reject(new Error('Hold refused'));
    await settled();
    commits[0]?.reject(new Error('Ship offline'));
    await settled();
    expect(deferred.getSnapshot().failed.map(entry => [entry.action.label, entry.message])).toEqual([
      ['Hold', 'Hold refused'],
      ['Ship', 'Ship offline'],
    ]);
    expect(conversation(deferred)).toEqual([
      { text: 'Ship', via: 'device', refused: true },
      { text: 'Hold', via: 'device', refused: true },
    ]);
  });

  test('a refusal of the first keeps its Not sent while the second is still on its way', async () => {
    const { deferred, commits } = twoSends();
    commits[0]?.reject(new Error('The ask was replaced.'));
    await settled();
    expect(sent(deferred)).toEqual(['Hold']);
    expect(deferred.getSnapshot().failed.map(entry => entry.action.label)).toEqual(['Ship']);
  });

  test('two instances over the same receipts keep each other’s sends apart', async () => {
    const receipts = new AnswerReceipts();
    const { timers, advance } = fakeTimers();
    const gates: (() => void)[] = [];
    const make = () =>
      new DeferredAgendaActions(
        () => new Promise<void>(resolve => gates.push(resolve)),
        timers,
        UNDO_WINDOW_MS,
        receipts,
      );
    const first = make();
    const second = make();
    first.schedule(card(), SHIP);
    second.schedule(card(item({ id: 'A2' })), HOLD);
    advance(UNDO_WINDOW_MS);
    expect(first.getSnapshot().sending.map(entry => entry.action.label)).toEqual(['Ship', 'Hold']);
    gates[0]?.();
    await settled();
    expect(second.getSnapshot().sending.map(entry => entry.action.label)).toEqual(['Hold']);
  });
});
