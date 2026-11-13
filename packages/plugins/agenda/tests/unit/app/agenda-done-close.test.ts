import { describe, expect, it } from 'bun:test';
import type { TaskRef } from '@ferretry/core-asks/contract';
import {
  closeCards,
  type DoneCloseResult,
  doneCloseLabel,
  doneCloseShortLabel,
  offeredCards,
} from '../../../app/lib/agenda-done-close.ts';

const F12: TaskRef = { id: 'F12' };

describe('which cards an agenda item offers to close', () => {
  it('offers the linked card only when the item asked', () => {
    expect(offeredCards({ offerClose: true, task: F12 }, 'daemon/a')).toEqual([F12]);
    expect(offeredCards({ task: F12 }, 'daemon/a')).toEqual([]);
  });

  it('offers nothing without a card, for a notice, or for a card of another machine', () => {
    expect(offeredCards({ offerClose: true }, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: null as never }, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: F12, notice: true }, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: { id: 'F12', machineId: 'daemon/b' } }, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: { id: 'F12', machineId: 'daemon/a' } }, 'daemon/a')).toEqual([
      { id: 'F12', machineId: 'daemon/a' },
    ]);
  });
});

describe('the button’s words', () => {
  it('names every card it closes', () => {
    expect(doneCloseLabel([F12])).toBe('Done · closes &F12');
    expect(doneCloseLabel([F12, { id: 'F13' }])).toBe('Done · closes &F12, &F13');
    // A narrow row's words: the one card, or how many.
    expect(doneCloseShortLabel([F12])).toBe('Close &F12');
    expect(doneCloseShortLabel([F12, { id: 'F13' }, { id: 'F14' }])).toBe('Close 3 cards');
  });
});

describe('closing several cards in turn', () => {
  const run = async (answers: Record<string, DoneCloseResult>, refs: readonly TaskRef[]) => {
    const asked: string[] = [];
    const result = await closeCards(refs, async ref => {
      asked.push(ref.id);
      return answers[ref.id] ?? { ok: true };
    });
    return { result, asked };
  };

  it('closes them all, in order', async () => {
    expect(await run({}, [F12, { id: 'F13' }])).toEqual({ result: { ok: true }, asked: ['F12', 'F13'] });
    expect(await run({}, [])).toEqual({ result: { ok: true }, asked: [] });
  });

  it('stops at the first that will not close and names it', async () => {
    const first = await run({ F12: { ok: false, message: 'needs a reason' } }, [F12, { id: 'F13' }]);
    expect(first.asked).toEqual(['F12']);
    expect(first.result).toEqual({ ok: false, message: '&F12: needs a reason' });
  });

  it('says which cards did close before the one that failed', async () => {
    const second = await run({ F13: { ok: false, message: 'gone' } }, [F12, { id: 'F13' }]);
    expect(second.result).toEqual({ ok: false, message: '&F13: gone (&F12 closed)' });
  });
});
