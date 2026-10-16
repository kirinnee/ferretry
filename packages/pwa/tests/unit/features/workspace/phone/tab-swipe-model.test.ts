import { describe, expect, it } from 'bun:test';
import {
  advanceTabSwipe,
  beginTabSwipe,
  resolveTabSwipe,
  SWIPE_DISTANCE_PX,
  SWIPE_FLICK_DISTANCE_PX,
  SWIPE_LOCK_SLOP_PX,
  type TabSwipe,
} from '../../../../../src/features/workspace/phone/tab-swipe-model.ts';

const start = (): TabSwipe => beginTabSwipe({ x: 200, y: 300, at: 0 });
const move = (swipe: TabSwipe, dx: number, dy: number, at: number): TabSwipe =>
  advanceTabSwipe(swipe, { x: 200 + dx, y: 300 + dy, at });

describe('tab swipe model', () => {
  it('starts undecided and at rest', () => {
    expect(start()).toEqual({ startX: 200, startY: 300, startAt: 0, dx: 0, dy: 0, at: 0, axis: 'undecided' });
  });

  it('decides nothing inside the slop', () => {
    const swipe = move(start(), SWIPE_LOCK_SLOP_PX - 1, 0, 50);
    expect(swipe.axis).toBe('undecided');
    expect(resolveTabSwipe(swipe)).toBeNull();
  });

  it('a long slow drag left is next, right is previous', () => {
    expect(resolveTabSwipe(move(move(start(), -20, 2, 100), -SWIPE_DISTANCE_PX, 4, 1000))).toBe('next');
    expect(resolveTabSwipe(move(move(start(), 20, 2, 100), SWIPE_DISTANCE_PX, 4, 1000))).toBe('previous');
  });

  it('a short slow drag is not a swipe', () => {
    expect(resolveTabSwipe(move(move(start(), -20, 0, 100), -40, 0, 1000))).toBeNull();
  });

  it('a short fast flick is a swipe', () => {
    expect(resolveTabSwipe(move(move(start(), -15, 0, 10), -SWIPE_FLICK_DISTANCE_PX, 0, 40))).toBe('next');
  });

  it('a mostly vertical move locks vertical and never becomes a swipe', () => {
    const vertical = move(start(), 8, 20, 50);
    expect(vertical.axis).toBe('vertical');
    expect(resolveTabSwipe(move(vertical, -200, 30, 300))).toBeNull();
  });

  it('a diagonal that is not sideways enough reads as vertical', () => {
    expect(move(start(), 14, 12, 50).axis).toBe('vertical');
  });

  it('a gesture that never left the slop resolves to nothing', () => {
    expect(resolveTabSwipe(start())).toBeNull();
  });
});
