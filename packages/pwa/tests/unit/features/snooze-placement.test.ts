import { describe, expect, it } from 'bun:test';
import { placeWithin } from '../../../src/features/agenda/snooze-placement.ts';

const view = { width: 390, height: 844 };
const box = (left: number, top: number, width = 180, height = 200) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('placeWithin — a menu that stays inside the viewport', () => {
  it('leaves a menu that already fits alone', () => {
    expect(placeWithin(box(20, 100), box(20, 60, 40, 40), view, 8)).toEqual({ dx: 0, flip: false });
  });

  it('shifts right a menu that opens off the left edge', () => {
    expect(placeWithin(box(-120, 300), box(40, 260, 40, 40), view, 8)).toEqual({ dx: 128, flip: false });
  });

  it('shifts left a menu that opens off the right edge', () => {
    expect(placeWithin(box(300, 100), box(330, 60, 40, 40), view, 8)).toEqual({ dx: -98, flip: false });
  });

  it('flips above the trigger when there is no room below and room above', () => {
    expect(placeWithin(box(20, 700), box(20, 660, 40, 40), view, 8).flip).toBe(true);
  });

  it('stays below when it fits neither way', () => {
    expect(placeWithin(box(20, 40, 180, 800), box(20, 0, 40, 40), view, 8).flip).toBe(false);
  });
});
