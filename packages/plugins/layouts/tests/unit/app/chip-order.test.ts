import { describe, expect, test } from 'bun:test';
import { chipDropIndex } from '../../../app/lib/chip-order.ts';

// Two columns of 100 x 40 chips: (50,20) (150,20) / (50,60) (150,60) / (50,100).
const others = [
  { x: 50, y: 20 },
  { x: 150, y: 20 },
  { x: 50, y: 60 },
  { x: 150, y: 60 },
  { x: 50, y: 100 },
];

describe('where a dragged chip belongs in a grid', () => {
  test('left of every chip on the first row is first', () => {
    expect(chipDropIndex(others, { x: 10, y: 20 }, 40)).toBe(0);
  });
  test('between the two chips of a row is after the left one', () => {
    expect(chipDropIndex(others, { x: 100, y: 20 }, 40)).toBe(1);
    expect(chipDropIndex(others, { x: 100, y: 60 }, 40)).toBe(3);
  });
  test('right of a row is after the whole row', () => {
    expect(chipDropIndex(others, { x: 190, y: 20 }, 40)).toBe(2);
  });
  test('below the last row is last, and a row between two rows follows its own row', () => {
    expect(chipDropIndex(others, { x: 190, y: 300 }, 40)).toBe(5);
    expect(chipDropIndex(others, { x: 190, y: 60 }, 40)).toBe(4);
  });
  test('an empty grid and a lone chip drop at the start', () => {
    expect(chipDropIndex([], { x: 5, y: 5 }, 40)).toBe(0);
  });
});
