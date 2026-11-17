import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import type { QueuedMessage } from '../../../contract/index.ts';
import should from 'should';
import {
  boardOnly,
  deliveryOrder,
  effectiveLabel,
  LANE_COLOUR,
  LANE_ORDER,
  planDelivery,
  promotedToUrgent,
} from '../../../contract/index.ts';
import { defaultQueueCoalesceSettings, type QueueCoalesceSettings } from '../../../contract/index.ts';
import { type SendTarget } from '../../../contract/index.ts';
import { parseSessionId } from '../../../contract/index.ts';

const at = (seconds: number): Instant =>
  new Date(Date.UTC(2026, 9, 30, 13, 0, seconds)).toISOString() as Instant as Instant;

function message(
  id: string,
  sender: QueuedMessage['sender'],
  seconds: number,
  state: QueuedMessage['state'] = 'queued',
) {
  return {
    v: 1,
    id,
    sender,
    text: id,
    attachmentIds: [],
    enqueuedAt: at(seconds),
    state,
    stateAt: at(seconds),
    revision: 1,
  } satisfies QueuedMessage;
}

describe('who goes first', () => {
  it("should deliver the owner's message before any ferret's, and a ferret's before the daemon's", () => {
    // Nine Warden notices were typed ahead of the owner's message on 2026-10-30.
    const queue = [
      message('warden-1', 'daemon', 0),
      message('peer-1', 'agent', 1),
      message('warden-2', 'daemon', 2),
      message('owner-1', 'human', 3),
      message('peer-2', 'agent', 4),
    ];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql([
      'owner-1',
      'peer-1',
      'peer-2',
      'warden-1',
      'warden-2',
    ]);
  });

  it('should keep acceptance order within one sender, even for messages accepted in the same instant', () => {
    const queue = [message('b', 'human', 5), message('a', 'human', 5), message('c', 'human', 1)];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql(['c', 'b', 'a']);
  });

  it('should leave out every message that is not waiting', () => {
    const queue = [
      message('typing', 'human', 0, 'typing'),
      message('done', 'human', 0, 'delivered'),
      message('gone', 'human', 0, 'cancelled'),
      message('next', 'agent', 1),
    ];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql(['next']);
  });
});

describe("the owner's own chat", () => {
  it('should never type a daemon notice into an interactive session', () => {
    const queue = [message('warden', 'daemon', 0), message('peer', 'agent', 1)];

    should(boardOnly(queue[0] as QueuedMessage, 'interactive')).be.true();
    should(boardOnly(queue[0] as QueuedMessage, 'auto')).be.false();
    should(boardOnly(queue[1] as QueuedMessage, 'interactive')).be.false();
    should(deliveryOrder(queue, 'interactive').map(entry => entry.id)).eql(['peer']);
  });
});

describe('what to deliver next, and when', () => {
  const TARGET: SendTarget = {
    id: parseSessionId('session-1'),
    status: 'running',
    mode: 'auto',
    turn: 1,
    harness: 'claude',
  };
  const SETTINGS = defaultQueueCoalesceSettings;
  const NOW_S = 100;

  const ferret = (
    id: string,
    seconds: number,
    label: 'blocker' | 'action' | 'fyi' | undefined,
    extra: Partial<QueuedMessage> = {},
  ): QueuedMessage => {
    const hold = label === 'fyi' && extra.replyExpected !== true ? SETTINGS.fyiMaxHoldMs : SETTINGS.actionWindowMs;
    return {
      ...message(id, 'agent', seconds),
      ...(label === undefined ? {} : { label }),
      ...(label === 'blocker' || label === undefined
        ? {}
        : { holdUntil: new Date(Date.parse(at(seconds)) + hold).toISOString() as Instant }),
      ...extra,
    };
  };
  const plan = (
    messages: readonly QueuedMessage[],
    nowSeconds = NOW_S,
    target: Partial<SendTarget> = {},
    settings: Partial<QueueCoalesceSettings> = {},
  ) => planDelivery(messages, { target: { ...TARGET, ...target } }, at(nowSeconds), { ...SETTINGS, ...settings });
  const ids = (result: ReturnType<typeof plan>): string[] =>
    result?.kind === 'batch'
      ? result.members.map(entry => entry.id)
      : result?.kind === 'single'
        ? [result.message.id]
        : [];

  it("should deliver the owner's message alone and first, however much ferret mail is due", () => {
    const result = plan([ferret('b', 0, 'blocker'), message('owner', 'human', 50)]);

    should(result).eql({ kind: 'single', message: message('owner', 'human', 50) });
  });

  it('should never hold a daemon notice behind a ferret message that is still held', () => {
    const result = plan([ferret('a', 90, 'action'), message('warden', 'daemon', 95)]);

    should(ids(result)).eql(['warden']);
  });

  it('should hold an action until its window ends, and name when', () => {
    const queue = [ferret('a', 90, 'action')];

    should(plan(queue, 100)).eql({ kind: 'hold', until: queue[0]?.holdUntil });
    should(ids(plan(queue, 150))).eql(['a']);
  });

  it('should deliver a blocker at once, carrying every pending ferret message in acceptance order', () => {
    const queue = [ferret('a', 10, 'action'), ferret('f', 20, 'fyi'), ferret('b', 30, 'blocker')];

    should(plan(queue, 31)).have.property('kind', 'batch');
    should(ids(plan(queue, 31))).eql(['a', 'f', 'b']);
  });

  it('should combine actions that arrive within the window, and start a new window afterwards', () => {
    should(ids(plan([ferret('a', 0, 'action'), ferret('b', 59, 'action')], 60))).eql(['a', 'b']);
    should(ids(plan([ferret('late', 61, 'action')], 62))).eql([]);
  });

  it('should hold an FYI past the end of a turn that came BEFORE it, and deliver it at the next one', () => {
    const queue = [ferret('f', 50, 'fyi')];

    should(plan(queue, 60, { turnState: 'your-turn', turnStateAt: at(40) })?.kind).equal('hold');
    should(ids(plan(queue, 70, { turnState: 'your-turn', turnStateAt: at(65) }))).eql(['f']);
    should(plan(queue, 70, { turnState: 'working', turnStateAt: at(65) })?.kind).equal('hold');
  });

  it('should deliver an FYI at its cap with no turn end at all', () => {
    const queue = [ferret('f', 0, 'fyi')];

    should(plan(queue, 599)?.kind).equal('hold');
    should(ids(plan(queue, 600))).eql(['f']);
  });

  it('should let a due action carry the FYIs waiting with it', () => {
    should(ids(plan([ferret('f', 0, 'fyi'), ferret('a', 30, 'action')], 90))).eql(['f', 'a']);
  });

  it('should never hold a question — as news or to be combined — nor a reply to a ferret that is waiting on it', () => {
    for (const label of ['fyi', 'action', undefined] as const) {
      const question = ferret('q', 0, label, { replyExpected: true });
      should(effectiveLabel(question, TARGET, SETTINGS)).equal('blocker');
      should(ids(plan([question], 1))).eql(['q']);
    }

    const reply = ferret('r', 0, 'action', { from: 'peer-1' });
    should(ids(plan([reply], 1, { waiting: { peer: 'peer-1' } }))).eql(['r']);
  });

  it('should deliver an interrupt (--now) at once', () => {
    should(ids(plan([ferret('n', 0, 'action', { interrupt: true })], 1))).eql(['n']);
  });

  it('should not let FYIs alone revive a stopped session, and say why', () => {
    should(plan([ferret('f', 0, 'fyi')], 700, { status: 'stopped' })).eql({ kind: 'hold', reason: 'stopped' });
    should(ids(plan([ferret('f', 0, 'fyi'), ferret('a', 10, 'blocker')], 700, { status: 'stopped' }))).eql(['f', 'a']);
  });

  it('should not let an expired FYI hold a Warden alert behind it on a stopped session', () => {
    const queue = [ferret('f', 0, 'fyi'), message('warden', 'daemon', 650)];
    const stopped = { status: 'stopped' } as const;

    should(ids(plan(queue, 700, stopped))).eql(['warden']);
    should(plan([ferret('f', 0, 'fyi')], 700, stopped)).eql({ kind: 'hold', reason: 'stopped' });
  });

  it('should drain FYIs capped at batchMax so a blocker, action or reply behind them is not held forever on a stopped session', () => {
    const fyis = ['f1', 'f2', 'f3'].map((id, index) => ferret(id, index, 'fyi'));
    const later: Readonly<Record<string, QueuedMessage>> = {
      blocker: ferret('later', 10, 'blocker'),
      action: ferret('later', 10, 'action'),
      reply: ferret('later', 10, 'action', { from: 'peer-1' }),
    };
    for (const [name, last] of Object.entries(later)) {
      const target = { status: 'stopped', ...(name === 'reply' ? { waiting: { peer: 'peer-1' } } : {}) } as const;
      const queue = [...fyis, last];

      should(ids(plan(queue, 700, target, { batchMax: 3 }))).eql(['f1', 'f2', 'f3']);
      should(ids(plan([last], 700, target, { batchMax: 3 }))).eql(['later']);
    }
  });

  it('should cap one turn at batchMax and leave the rest for the next', () => {
    const queue = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ferret(id, index, 'action'));

    should(ids(plan(queue, 70, {}, { batchMax: 2 }))).eql(['a', 'b']);
  });

  it('should deliver a lone ferret message as a plain single, not a batch of one', () => {
    should(plan([ferret('a', 0, 'action')], 70)).have.property('kind', 'single');
  });

  it('should deliver every ferret message at once, one turn each, with the kill switch off', () => {
    const queue = [ferret('a', 90, 'action'), ferret('f', 91, 'fyi')];

    should(ids(plan(queue, 92, {}, { coalesce: false }))).eql(['a']);
    should(effectiveLabel(queue[1] as QueuedMessage, TARGET, { coalesce: false })).equal('blocker');
  });

  it('should deliver mail queued before labels existed straight away', () => {
    should(ids(plan([ferret('old', 0, undefined)], 1))).eql(['old']);
  });

  it('should deliver nothing while a message is being typed', () => {
    should(plan([message('t', 'agent', 0, 'typing'), ferret('b', 0, 'blocker')])).equal(undefined);
    should(plan([message('typing', 'agent', 0, 'typing'), message('owner', 'human', 1)])).equal(undefined);
  });
});

describe('lanes decide delivery', () => {
  const lane = (
    id: string,
    laneName: NonNullable<QueuedMessage['lane']>,
    seconds: number,
    extra: Partial<QueuedMessage> = {},
  ) =>
    ({
      ...message(id, laneName === 'owner' ? 'human' : laneName === 'ferretry' ? 'daemon' : 'agent', seconds),
      lane: laneName,
      ...(laneName === 'action' ? { holdUntil: at(seconds + 60) } : {}),
      ...(laneName === 'fyi' ? { holdUntil: at(seconds + 600) } : {}),
      ...extra,
    }) satisfies QueuedMessage;
  const target = { id: parseSessionId('s'), status: 'running', mode: 'auto', turn: 1 } as const satisfies SendTarget;
  const plan = (queue: readonly QueuedMessage[], nowSeconds: number, view: Partial<SendTarget> = {}) =>
    planDelivery(queue, { target: { ...target, ...view } }, at(nowSeconds), defaultQueueCoalesceSettings);
  const ids = (result: ReturnType<typeof plan>): string[] =>
    result?.kind === 'batch'
      ? result.members.map(entry => entry.id)
      : result?.kind === 'single'
        ? [result.message.id]
        : [];

  it('should go owner, then urgent carrying what waits, then ferretry, then the held action and fyi', () => {
    const queue = [
      lane('fyi', 'fyi', 0),
      lane('action', 'action', 1),
      lane('warden', 'ferretry', 2),
      lane('urgent', 'urgent', 3),
      lane('owner', 'owner', 4),
    ];

    should(ids(plan(queue, 10))).eql(['owner']);
    should(ids(plan(queue.slice(0, 4), 10))).eql(['fyi', 'action', 'urgent']);
    should(ids(plan([queue[0]!, queue[1]!, queue[2]!], 10))).eql(['warden']);
  });

  it('should let Ferretry pass a held action or fyi, but never one that is already due', () => {
    const queue = [lane('action', 'action', 0), lane('fyi', 'fyi', 1), lane('warden', 'ferretry', 2)];

    should(ids(plan(queue, 30))).eql(['warden']);
    should(ids(plan(queue, 61))).eql(['action', 'fyi']);
  });

  it('should read the stored lane, never the label or flags again', () => {
    // Accepted as an fyi: a label that now says blocker does not make it urgent.
    const stored = lane('f', 'fyi', 0, { label: 'blocker', replyExpected: true, interrupt: true });

    should(effectiveLabel(stored, target, defaultQueueCoalesceSettings)).equal('fyi');
    should(plan([stored], 10)).eql({ kind: 'hold', until: stored.holdUntil });
  });

  it('should derive the lane of an old message that has none, from its fields, for this read only', () => {
    const old = { ...message('o', 'agent', 0), label: 'fyi', holdUntil: at(600) } satisfies QueuedMessage;

    should(effectiveLabel(old, target, defaultQueueCoalesceSettings)).equal('fyi');
    should(effectiveLabel({ ...old, replyExpected: true }, target, defaultQueueCoalesceSettings)).equal('blocker');
  });

  it('should promote an action or fyi that answers what the receiver waits on, and no other lane', () => {
    const waiting = { waiting: { peer: 'peer-1' } } as const;
    const settings = defaultQueueCoalesceSettings;
    const withTarget = { ...target, ...waiting };
    const reply = (laneName: NonNullable<QueuedMessage['lane']>) => lane('r', laneName, 0, { from: 'peer-1' });

    should(promotedToUrgent(reply('action'), withTarget, settings)).be.true();
    should(promotedToUrgent(reply('fyi'), withTarget, settings)).be.true();
    should(promotedToUrgent(reply('urgent'), withTarget, settings)).be.false();
    should(promotedToUrgent(reply('action'), target, settings)).be.false();
    should(promotedToUrgent(reply('action'), withTarget, { ...settings, coalesce: false })).be.false();
    should(ids(plan([reply('fyi')], 1, waiting))).eql(['r']);
  });

  it('should send every lane at once, one turn each, with the kill switch off', () => {
    const queue = [lane('a', 'action', 0), lane('f', 'fyi', 1)];
    const result = planDelivery(queue, { target }, at(2), { ...defaultQueueCoalesceSettings, coalesce: false });

    should(result).eql({ kind: 'single', message: queue[0] });
  });

  it('should name a colour token per lane', () => {
    should(LANE_COLOUR).eql({ owner: '--accent', urgent: '--err', ferretry: '--ok', action: '--warn', fyi: '--pend' });
    should(LANE_ORDER).eql(['owner', 'urgent', 'ferretry', 'action', 'fyi']);
  });
});
