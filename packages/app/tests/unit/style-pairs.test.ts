import { describe, expect, it } from 'bun:test';
import { lookDistance } from '../support/style-pairs.ts';

/** A 4-cell "picture": the page ground (200) everywhere except the cells given. */
const picture = (...cells: readonly (readonly [number, number])[]): number[] => {
  const grid = [200, 200, 200, 200, 200, 200, 200, 200];
  for (const [at, level] of cells) grid[at] = level;
  return grid;
};

describe('how far apart two styles look', () => {
  it('is 0 for the same picture, and for two blank pages', () => {
    expect(lookDistance(picture([1, 40], [2, 40]), picture([1, 40], [2, 40]))).toBe(0);
    expect(lookDistance(picture(), picture())).toBe(0);
  });

  it('averages the grey difference over the cells either style draws on, never over the shared ground', () => {
    // One cell drawn by A (40 against B's 200): 160 apart; the 7 other cells are ground in both and do not dilute it.
    expect(lookDistance(picture([1, 40]), picture())).toBe(160);
    // A draws cell 1 (40 vs 200 = 160), B draws cell 2 (60 vs 200 = 140): the mean over the two drawn cells.
    expect(lookDistance(picture([1, 40]), picture([2, 60]))).toBe(150);
  });

  it('is symmetric, and is measured against each picture\'s own ground, so a darker page alone is not "drawing"', () => {
    const a = picture([3, 10]);
    const b = picture([5, 90]);
    expect(lookDistance(a, b)).toBe(lookDistance(b, a));
    const darkPage = Array.from({ length: 8 }, () => 20);
    expect(lookDistance(darkPage, darkPage)).toBe(0);
  });
});
