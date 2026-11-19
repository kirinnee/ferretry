import { describe, expect, test } from 'bun:test';
import {
  cancelledMessage,
  dropIndex,
  droppedMessage,
  liftedMessage,
  movedMessage,
  moveItem,
  sameOrder,
} from '../../../src/ui/lib/sortable-order.ts';

describe('moveItem', () => {
  test('moves a row to another place without touching the input', () => {
    const input = ['a', 'b', 'c', 'd'] as const;
    expect(moveItem(input, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(input, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  test('clamps the target into the list', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });

  test('answers the SAME array when nothing moves or the source is not a row', () => {
    const input = ['a', 'b'];
    expect(moveItem(input, 1, 1)).toBe(input);
    expect(moveItem(input, 1, 9)).toBe(input);
    expect(moveItem(input, -1, 0)).toBe(input);
    expect(moveItem(input, 5, 0)).toBe(input);
  });
});

describe('dropIndex', () => {
  test('counts the other rows whose middle is above the dragged middle', () => {
    expect(dropIndex([25, 75, 125], 10)).toBe(0);
    expect(dropIndex([25, 75, 125], 80)).toBe(2);
    expect(dropIndex([25, 75, 125], 500)).toBe(3);
    expect(dropIndex([], 5)).toBe(0);
  });
});

describe('sameOrder', () => {
  test('compares sequence, not membership', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('the words a screen reader hears', () => {
  test('say the place as one-based, out of the count', () => {
    expect(liftedMessage('Board', 1, 4)).toBe(
      'Board lifted, position 2 of 4. Arrow keys move it, Enter drops it, Escape cancels.',
    );
    expect(movedMessage('Board', 0, 4)).toBe('Board moved to position 1 of 4.');
    expect(droppedMessage('Board', 3, 4)).toBe('Board dropped at position 4 of 4.');
    expect(cancelledMessage('Board', 1, 4)).toBe('Reorder cancelled. Board is back at position 2 of 4.');
  });
});
