import { describe, expect, test } from 'bun:test';
import { placePopover } from '../../../src/ui/lib/popover-placement.ts';

/** A 1280×720 window; the trigger is a 32px button, its box given by edges. */
const VIEW = { width: 1_280, height: 720 };
const trigger = (left: number, top: number) => ({ left, right: left + 32, top, bottom: top + 32 });
const MENU = { width: 352, height: 240 };

describe('placePopover', () => {
  test('opens under the trigger, its right edge on the trigger’s right edge', () => {
    const at = placePopover(trigger(900, 100), MENU, VIEW);
    expect(at).toEqual({ left: 932 - 352, top: 100 + 32 + 4, maxHeight: 240 });
  });

  test('never leaves the window sideways: a trigger near the left edge opens rightwards from the margin', () => {
    expect(placePopover(trigger(20, 100), MENU, VIEW).left).toBe(8);
    expect(placePopover(trigger(1_270, 100), MENU, VIEW).left).toBe(1_280 - 352 - 8);
  });

  test('flips above the trigger when there is no room below and more above', () => {
    const at = placePopover(trigger(900, 600), MENU, VIEW);
    expect(at.top).toBe(600 - 4 - 240);
    expect(at.maxHeight).toBe(240);
  });

  test('stays below, scrolling inside a capped height, when neither side holds the whole menu', () => {
    const tall = { width: 352, height: 900 };
    const at = placePopover(trigger(900, 100), tall, VIEW);
    expect(at.top).toBe(136);
    expect(at.maxHeight).toBe(720 - 136 - 8);
  });

  test('a window narrower than the menu pins it to the margin', () => {
    expect(placePopover(trigger(100, 100), MENU, { width: 300, height: 700 }).left).toBe(8);
  });
});
