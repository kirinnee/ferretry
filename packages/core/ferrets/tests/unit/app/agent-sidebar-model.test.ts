/**
 * The sidebar's decisions, asserted without a browser.
 *
 * The gesture thresholds and the bulk-run token are the two places this surface
 * can go wrong invisibly: a mis-tuned press either swallows navigation or opens
 * a menu mid-scroll, and a stale token lets a superseded sweep overwrite the
 * dialog a person is currently reading.
 */

import { describe, expect, it } from 'bun:test';

import {
  cancelsRowLongPress,
  CLICK_SUPPRESS_MS,
  MOVE_CANCEL_PX,
  suppressesRowClick,
} from '../../../app/shell/agent-sidebar-model.ts';

describe('row gesture policy', () => {
  it('keeps a press that has barely moved', () => {
    const start = { x: 100, y: 100 };
    expect(cancelsRowLongPress(start, { x: 100 + MOVE_CANCEL_PX, y: 100 })).toBe(false);
    expect(cancelsRowLongPress(start, { x: 100, y: 100 - MOVE_CANCEL_PX })).toBe(false);
  });

  it('cancels a press that drifted past the threshold on either axis', () => {
    const start = { x: 100, y: 100 };
    expect(cancelsRowLongPress(start, { x: 100 + MOVE_CANCEL_PX + 1, y: 100 })).toBe(true);
    expect(cancelsRowLongPress(start, { x: 100, y: 100 + MOVE_CANCEL_PX + 1 })).toBe(true);
  });

  it('suppresses the click the menu-opening press fires, then stops suppressing', () => {
    expect(suppressesRowClick(1_000, 1_000)).toBe(true);
    expect(suppressesRowClick(1_000, 1_000 + CLICK_SUPPRESS_MS - 1)).toBe(true);
    expect(suppressesRowClick(1_000, 1_000 + CLICK_SUPPRESS_MS)).toBe(false);
    // Nothing fired yet: a click in the first moments of a page, when the clock itself reads near zero.
    expect(suppressesRowClick(0, 1)).toBe(false);
  });
});
