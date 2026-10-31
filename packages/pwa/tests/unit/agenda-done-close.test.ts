import { describe, expect, it } from 'bun:test';
import type { TaskRef } from '@ferretry/protocol';
import {
  closeCards,
  closePlan,
  type DoneCloseResult,
  doneCloseLabel,
  doneCloseShortLabel,
  offeredCards,
} from '../../src/lib/agenda-done-close.ts';
import { laneSetFor } from './board-support.ts';

const lanes = laneSetFor();
const F12: TaskRef = { id: 'F12' };

describe('which cards an agenda item offers to close', () => {
  it('offers the linked card only when the item asked AND the machine takes the field', () => {
    expect(offeredCards({ offerClose: true, task: F12 }, true, 'daemon/a')).toEqual([F12]);
    expect(offeredCards({ task: F12 }, true, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: F12 }, false, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: F12 }, undefined, 'daemon/a')).toEqual([]);
  });

  it('offers nothing without a card, for a notice, or for a card of another machine', () => {
    expect(offeredCards({ offerClose: true }, true, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: null as never }, true, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: F12, notice: true }, true, 'daemon/a')).toEqual([]);
    expect(offeredCards({ offerClose: true, task: { id: 'F12', machineId: 'daemon/b' } }, true, 'daemon/a')).toEqual(
      [],
    );
    expect(offeredCards({ offerClose: true, task: { id: 'F12', machineId: 'daemon/a' } }, true, 'daemon/a')).toEqual([
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

describe('the lane a Done moves a card into', () => {
  it('moves an open card into the Closed lane', () => {
    expect(closePlan({ laneId: 'tested', dropped: false, laneSet: lanes })).toEqual({ kind: 'move', laneId: 'closed' });
  });

  it('has nothing to do for a card that is already closed', () => {
    expect(closePlan({ laneId: 'closed', dropped: false, laneSet: lanes })).toEqual({ kind: 'closed' });
  });

  it('refuses a card it cannot read, a dropped one and one on a board with no lanes', () => {
    expect(closePlan(undefined)).toEqual({ kind: 'refused', message: 'the card could not be read' });
    expect(closePlan({ laneId: 'tested', dropped: true, laneSet: lanes })).toEqual({
      kind: 'refused',
      message: 'the board has no Done for this card',
    });
    expect(closePlan({ laneId: 'tested', dropped: false, laneSet: null })).toEqual({
      kind: 'refused',
      message: 'the board has no Done for this card',
    });
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
