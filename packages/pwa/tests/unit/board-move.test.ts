import { describe, expect, it } from 'bun:test';
import { moveChoices, planMove } from '../../src/lib/board-move.ts';
import { laneSetFor } from './board-support.ts';

const lanes = laneSetFor();

describe('planMove', () => {
  it('stays when dropped where it already is', () => {
    expect(planMove(lanes, 'implement', 'implement')).toEqual({ kind: 'stay' });
  });

  it('sends a forward move at once', () => {
    expect(planMove(lanes, 'implement', 'review')).toEqual({ kind: 'send', to: 'review', closing: false });
  });

  it('closes in one step when the target is a Closed lane', () => {
    expect(planMove(lanes, 'tested', 'closed')).toEqual({ kind: 'send', to: 'closed', closing: true });
  });

  it('asks for a reason before a move back', () => {
    expect(planMove(lanes, 'review', 'implement')).toEqual({ kind: 'ask-reason', to: 'implement' });
  });

  it('refuses without a lane set, and for a lane that is not on the board', () => {
    expect(planMove(null, 'a', 'b').kind).toBe('refused');
    const unknownTarget = planMove(lanes, 'implement', 'nowhere');
    expect(unknownTarget).toEqual({ kind: 'refused', message: "Lane nowhere is not on this project's board." });
    const unknownOrigin = planMove(lanes, 'ghost', 'review');
    expect(unknownOrigin.kind).toBe('refused');
  });
});

describe('moveChoices', () => {
  it('lists every other lane and marks the ones behind the card', () => {
    const choices = moveChoices(lanes, 'review');
    expect(choices.map(choice => choice.laneId)).toEqual([
      'todo',
      'plan',
      'implement',
      'merged',
      'released',
      'tested',
      'closed',
    ]);
    expect(choices.filter(choice => choice.backward).map(choice => choice.laneId)).toEqual([
      'todo',
      'plan',
      'implement',
    ]);
    expect(choices[0]?.name).toBe('Todo');
  });

  it('marks nothing backward for a lane the set does not know, and is empty without a lane set', () => {
    expect(moveChoices(lanes, 'ghost').some(choice => choice.backward)).toBe(false);
    expect(moveChoices(null, 'review')).toEqual([]);
  });
});
