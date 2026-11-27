import { describe, expect, it } from 'bun:test';
import { type DeferredAgendaState, type InboxAction, type InboxCard } from '../../../app/lib/agenda-inbox.ts';
import { RETRY_LABEL } from '../../../app/lib/agenda-answers.ts';
import {
  refusedAgain,
  type RetriedAnswer,
  withoutSettledRetries,
  withRetriesOf,
} from '../../../app/lib/refused-again.ts';
import { agendaItem, inboxCard } from '../../support/app/agenda-inbox.tsx';

const refused = (id: string, at: string): InboxCard => {
  const card = inboxCard(agendaItem(id));
  return {
    ...card,
    item: { ...card.item, undelivered: { at, reply: { action: 'dismiss' }, reason: `why ${at}` } } as InboxCard['item'],
  };
};
const plain = (id: string): InboxCard => inboxCard(agendaItem(id));
const retry: InboxAction = { kind: 'dismiss', label: RETRY_LABEL };
const held = (card: InboxCard, action: InboxAction = retry, where: 'pending' | 'sending' = 'pending') =>
  ({
    pending: [],
    sending: [],
    failed: [],
    [where]: [{ id: 's1', key: card.key, card, action, at: 0, deadline: 5_000 }],
  }) as DeferredAgendaState;
const NOTHING: DeferredAgendaState = { pending: [], sending: [], failed: [] };
const nowhere = (): boolean => false;
/** The retry of `card` as the tracker holds it: the refusal's `at`, and the board it is on. */
const retriedFrom = (card: InboxCard, at: string): RetriedAnswer => ({
  at,
  daemonId: card.daemonId,
  sessionId: card.view.config.id,
  id: card.item.id,
});

describe('refused-again: a retried answer the board says was refused again', () => {
  const was = refused('A2', 'T1');

  it('remembers the refusal a retry was given from, whether it is held or on its way', () => {
    expect(withRetriesOf(new Map(), held(was))).toEqual(new Map([[was.key, retriedFrom(was, 'T1')]]));
    expect(withRetriesOf(new Map(), held(was, retry, 'sending'))).toEqual(new Map([[was.key, retriedFrom(was, 'T1')]]));
  });

  it('remembers no answer that is not a retry, and no retry of a task that was not refused', () => {
    expect(withRetriesOf(new Map(), held(was, { kind: 'dismiss', label: 'Dismiss' })).size).toBe(0);
    expect(withRetriesOf(new Map(), held(plain('A3'))).size).toBe(0);
  });

  it('is the same map when there is nothing new to remember', () => {
    const known = new Map([[was.key, retriedFrom(was, 'T1')]]);
    expect(withRetriesOf(known, held(was))).toBe(known);
    expect(withRetriesOf(known, NOTHING)).toBe(known);
  });

  it('says a task refused again only for an `at` other than the one it was retried from', () => {
    const known = new Map([[was.key, retriedFrom(was, 'T1')]]);
    expect(refusedAgain(known, [was], new Set())).toEqual([]);
    const again = refused('A2', 'T2');
    expect(refusedAgain(known, [again], new Set())).toEqual([again]);
    expect(refusedAgain(known, [again], new Set([again.key]))).toEqual([]);
    expect(refusedAgain(new Map(), [again], new Set())).toEqual([]);
  });

  it('lets a retry go once its task is open, delivered, gone, or back with no refusal; keeps a held one', () => {
    const known = new Map([[was.key, retriedFrom(was, 'T1')]]);
    expect(withoutSettledRetries(known, [refused('A2', 'T2')], new Set(), NOTHING, nowhere)).toBe(known);
    expect(withoutSettledRetries(known, [refused('A2', 'T2')], new Set([was.key]), NOTHING, nowhere).size).toBe(0);
    expect(withoutSettledRetries(known, [], new Set(), NOTHING, nowhere).size).toBe(0);
    expect(withoutSettledRetries(known, [plain('A2')], new Set(), NOTHING, nowhere).size).toBe(0);
    expect(withoutSettledRetries(known, [], new Set(), held(was), nowhere)).toBe(known);
  });

  it('keeps a retry the daemon still holds although its task is off the list, and lets it go once delivery settles', () => {
    const known = new Map([[was.key, retriedFrom(was, 'T1')]]);
    // The accepted board has the task closed and its reply held: it is absent from the list, and not delivered.
    expect(withoutSettledRetries(known, [plain('A3')], new Set(), NOTHING, () => true)).toBe(known);
    expect(withoutSettledRetries(known, [plain('A3')], new Set(), NOTHING, answer => answer.id === 'A2')).toBe(known);
    // Nothing is held for it any more and it is not listed: delivered.
    expect(withoutSettledRetries(known, [plain('A3')], new Set(), NOTHING, nowhere).size).toBe(0);
    // The daemon holds some OTHER task's reply, not this one.
    expect(withoutSettledRetries(known, [plain('A3')], new Set(), NOTHING, answer => answer.id === 'A9').size).toBe(0);
  });
});
