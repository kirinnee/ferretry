import { describe, expect, it } from 'bun:test';
import {
  RepliedAgenda,
  type RepliedPorts,
  type Withdrawal,
  parksOnReply,
  repliedAgrees,
  withRepliedCards,
  withRepliedParked,
} from '../../../app/lib/agenda-replied.ts';
import type { DeferredTimers } from '../../../app/lib/agenda-inbox.ts';
import { agendaItem, choices, inboxCard } from '../../support/app/agenda-inbox.tsx';

const card = inboxCard(agendaItem('A2', { ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }));
const other = inboxCard(agendaItem('A3', { ask: choices('Yes', 'No'), waitingSince: '2026-08-01T11:00:00.000Z' }));

const clock = () => {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const timing: DeferredTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: handle => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { timing, advance };
};

const agenda = (outcome: Withdrawal | Error = 'withdrawn', unsnooze: () => Promise<void> = async () => undefined) => {
  const time = clock();
  const log: string[] = [];
  const ports: RepliedPorts = {
    withdraw: async (_card, sendId) => {
      log.push(`withdraw ${sendId}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    unsnooze: async each => {
      log.push('unsnooze');
      await unsnooze();
      void each;
    },
  };
  return { replied: new RepliedAgenda(ports, time.timing), log, time };
};

describe('the replied overlay', () => {
  it('hides the card from the deck and lists it under Replied at once, and gives every other card back untouched', () => {
    const { replied } = agenda();
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    const state = replied.getSnapshot();
    expect(withRepliedCards([card, other], state).map(each => each.key)).toEqual([other.key]);
    const parked = withRepliedParked([], state);
    expect(parked.map(each => each.key)).toEqual([card.key]);
    expect(parked[0]?.item.parked?.reason).toBe('replied');
    const none = new RepliedAgenda({ withdraw: async () => 'taken', unsnooze: async () => undefined }).getSnapshot();
    const cards = [card, other];
    expect(withRepliedCards(cards, none)).toBe(cards);
  });

  it('does not park a notice or a gate item: a reply does not move those', () => {
    expect(parksOnReply(card.item)).toBe(true);
    expect(parksOnReply({ ...card.item, notice: true })).toBe(false);
    const { replied } = agenda();
    expect(replied.mark({ ...card, item: { ...card.item, notice: true } }, { words: 'x' })).toBe(false);
    expect(replied.getSnapshot().entries).toEqual([]);
  });

  it('agrees once the board shows the item parked or gone, or asking again; never for a board not read', () => {
    const { replied } = agenda();
    replied.mark(card, { words: 'hi' });
    const entry = replied.getSnapshot().entries[0];
    if (entry === undefined) throw new Error('no entry');
    expect(repliedAgrees(entry, undefined, false)).toBe(false);
    expect(repliedAgrees(entry, card.item, true)).toBe(false);
    expect(repliedAgrees(entry, { ...card.item, parked: { reason: 'replied', at: 'x' } } as never, false)).toBe(true);
    expect(repliedAgrees(entry, null, false)).toBe(true);
    expect(repliedAgrees(entry, { ...card.item, waitingSince: '2026-08-01T12:00:00.000Z' }, true)).toBe(true);
  });

  it('is dropped after its time-to-live even when the board never agrees', () => {
    const { replied, time } = agenda();
    replied.mark(card, { words: 'hi' });
    time.advance(29_000);
    expect(replied.getSnapshot().entries).toHaveLength(1);
    time.advance(2_000);
    expect(replied.getSnapshot().entries).toEqual([]);
  });

  it('offers Undo for its window only', () => {
    const { replied, time } = agenda();
    replied.mark(card, { words: 'hi' });
    expect(replied.undoable()?.key).toBe(card.key);
    time.advance(5_001);
    expect(replied.undoable()).toBeUndefined();
  });
});

describe('Undo', () => {
  it('withdraws a waiting message, hands the words back once, puts the card back and says so', async () => {
    const { replied, log } = agenda('withdrawn');
    replied.mark(card, { words: 'only after lunch', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    expect(log).toEqual(['withdraw m1', 'unsnooze']);
    const state = replied.getSnapshot();
    expect(state.restores).toEqual([{ key: card.key, text: 'only after lunch' }]);
    expect(state.notice?.kind).toBe('withdrawn');
    expect(withRepliedCards([], state).map(each => each.key)).toEqual([card.key]);
    expect(
      withRepliedParked([{ ...card, item: { ...card.item, parked: { reason: 'replied', at: 'x' } } as never }], state),
    ).toEqual([]);
    expect(replied.takeRestore(card.key)).toBe('only after lunch');
    expect(replied.takeRestore(card.key)).toBeUndefined();
  });

  it('only brings the card back when the ferret already took the message', async () => {
    const { replied, log } = agenda('taken');
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    expect(log).toEqual(['withdraw m1', 'unsnooze']);
    expect(replied.getSnapshot().restores).toEqual([]);
    expect(replied.getSnapshot().notice?.kind).toBe('read');
  });

  it('never asks the queue about a message the transport delivered at once, or one it has no id for', async () => {
    const delivered = agenda();
    delivered.replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'delivered' });
    await delivered.replied.undo();
    expect(delivered.log).toEqual(['unsnooze']);
    expect(delivered.replied.getSnapshot().notice?.kind).toBe('read');
    const unknown = agenda();
    unknown.replied.mark(card, { words: 'hi' });
    await unknown.replied.undo();
    expect(unknown.log).toEqual(['unsnooze']);
    expect(unknown.replied.getSnapshot().notice?.kind).toBe('unknown');
  });

  it('says the reply may still arrive when the queue cannot be reached, and still brings the card back', async () => {
    const { replied } = agenda(new Error('offline'));
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    const notice = replied.getSnapshot().notice;
    expect(notice?.kind).toBe('refused');
    expect(notice?.message).toBe('offline');
    expect(replied.getSnapshot().restores).toEqual([]);
  });

  it('keeps the words when the card cannot be put back, and says it could not', async () => {
    const { replied } = agenda('withdrawn', async () => {
      throw new Error('machine said no');
    });
    replied.mark(card, { words: 'only after lunch', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    const state = replied.getSnapshot();
    expect(state.notice).toMatchObject({ kind: 'not-back', message: 'machine said no' });
    expect(state.restores).toEqual([{ key: card.key, text: 'only after lunch' }]);
    expect(state.entries).toEqual([]);
  });

  it('reconcile drops an entry the board caught up with, and a card brought back once the board lists it open', async () => {
    const { replied } = agenda();
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    replied.reconcile(() => undefined, new Set());
    expect(replied.getSnapshot().entries).toHaveLength(1);
    replied.reconcile(() => ({ ...card.item, parked: { reason: 'replied', at: 'x' } }) as never, new Set());
    expect(replied.getSnapshot().entries).toEqual([]);

    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    replied.reconcile(() => ({ ...card.item, parked: { reason: 'replied', at: 'x' } }) as never, new Set());
    expect(replied.getSnapshot().entries).toHaveLength(1);
    replied.reconcile(() => card.item, new Set([card.key]));
    expect(replied.getSnapshot().entries).toEqual([]);
  });
});

describe('the overlay with several cards', () => {
  it('deals the cards Undo brought back among the others in waiting order, longest-waiting first', async () => {
    const { replied } = agenda();
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    await replied.undo();
    const dealt = withRepliedCards([other], replied.getSnapshot());
    expect(dealt.map(each => each.key)).toEqual([other.key, card.key]);
  });

  it('lists the cards under Replied newest first, ties by key', () => {
    const { replied, time } = agenda();
    time.advance(1_000);
    replied.mark(card, { words: 'hi' });
    const older = {
      ...other,
      item: { ...other.item, parked: { reason: 'replied', at: '2020-01-01T00:00:00.000Z' } },
    } as never as typeof other;
    const sameInstant = { ...older, key: 'zz', item: older.item } as typeof other;
    const parked = withRepliedParked([older, sameInstant], replied.getSnapshot());
    expect(parked.map(each => each.key)).toEqual([other.key, 'zz', card.key]);
  });
});

describe('the overlay housekeeping', () => {
  it('undoes the reply named by its key, and nothing for a key it does not hold', async () => {
    const { replied, log } = agenda();
    replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    await replied.undo('nope');
    expect(log).toEqual([]);
    await replied.undo(card.key);
    expect(log).toEqual(['withdraw m1', 'unsnooze']);
  });

  it('stops asking the page to open a card once it has, and ignores a card it never brought back', async () => {
    const { replied } = agenda();
    replied.mark(card, { words: 'hi' });
    replied.revealed(card.key);
    expect(replied.getSnapshot().entries[0]?.reveal).toBe(false);
    await replied.undo();
    expect(replied.getSnapshot().entries[0]?.reveal).toBe(true);
    replied.revealed('nope');
    expect(replied.getSnapshot().entries[0]?.reveal).toBe(true);
    replied.revealed(card.key);
    expect(replied.getSnapshot().entries[0]?.reveal).toBe(false);
  });

  it('forgets a notice once the toast has said it, and does nothing when there is none', async () => {
    const { replied } = agenda();
    replied.clearNotice();
    replied.mark(card, { words: 'hi' });
    await replied.undo();
    expect(replied.getSnapshot().notice).not.toBeNull();
    replied.clearNotice();
    expect(replied.getSnapshot().notice).toBeNull();
  });
});
