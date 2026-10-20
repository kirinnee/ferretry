import { describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  autoScrollDelta,
  cancelledMessage,
  droppedMessage,
  dropTarget,
  movedMessage,
  pickedUpMessage,
  SCROLL_EDGE_PX,
  SCROLL_MAX_PX,
  shifted,
} from '../../src/shell/machine-reorder-model.ts';

const [A, B, C] = ['a', 'b', 'c'] as DaemonId[] as [DaemonId, DaemonId, DaemonId];
const boxes = [
  { id: A, top: 0, bottom: 100 },
  { id: B, top: 100, bottom: 200 },
  { id: C, top: 200, bottom: 300 },
];

describe('dropTarget', () => {
  test('lands before the first heading whose middle is below the pointer', () => {
    expect(dropTarget(boxes, A, 120)).toEqual({ id: B, edge: 'before' });
    expect(dropTarget(boxes, C, 10)).toEqual({ id: A, edge: 'before' });
  });

  test('lands after the last other heading when the pointer is below every middle', () => {
    expect(dropTarget(boxes, A, 290)).toEqual({ id: C, edge: 'after' });
    expect(dropTarget(boxes, C, 900)).toEqual({ id: B, edge: 'after' });
  });

  test('is nothing when the dragged machine is alone', () => {
    expect(dropTarget([boxes[0] as (typeof boxes)[number]], A, 10)).toBeNull();
  });
});

describe('autoScrollDelta', () => {
  test('is still in the middle of the list', () => {
    expect(autoScrollDelta(150, 0, 300)).toBe(0);
  });

  test('scrolls up near the top and down near the bottom, faster the nearer the edge', () => {
    expect(autoScrollDelta(0, 0, 300)).toBe(-SCROLL_MAX_PX);
    expect(autoScrollDelta(SCROLL_EDGE_PX / 2, 0, 300)).toBe(-SCROLL_MAX_PX / 2);
    expect(autoScrollDelta(300, 0, 300)).toBe(SCROLL_MAX_PX);
    expect(autoScrollDelta(300 - SCROLL_EDGE_PX / 2, 0, 300)).toBe(SCROLL_MAX_PX / 2);
  });

  test('caps the speed when the pointer leaves the list', () => {
    expect(autoScrollDelta(-500, 0, 300)).toBe(-SCROLL_MAX_PX);
    expect(autoScrollDelta(900, 0, 300)).toBe(SCROLL_MAX_PX);
  });
});

describe('shifted', () => {
  test('swaps a machine with its neighbour and stops at the ends', () => {
    expect(shifted([A, B, C], B, -1)).toEqual([B, A, C]);
    expect(shifted([A, B, C], B, 1)).toEqual([A, C, B]);
    const order = [A, B, C];
    expect(shifted(order, A, -1)).toBe(order);
    expect(shifted(order, C, 1)).toBe(order);
    expect(shifted(order, 'x' as DaemonId, 1)).toBe(order);
  });
});

describe('the spoken messages', () => {
  test('name the machine and its place', () => {
    expect(pickedUpMessage('Mac', 1, 3)).toContain('Picked up Mac, position 2 of 3.');
    expect(movedMessage('Mac', 0, 3)).toBe('Mac moved to position 1 of 3.');
    expect(droppedMessage('Mac', 2, 3)).toBe('Dropped Mac at position 3 of 3.');
    expect(cancelledMessage('Mac', 1, 3)).toBe('Reorder cancelled. Mac is back at position 2 of 3.');
  });
});
