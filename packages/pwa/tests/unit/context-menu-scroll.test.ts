import { describe, expect, it } from 'bun:test';
import { decideScroll, isReaderDriven, READER_INPUT_WINDOW_MS } from '../../src/lib/context-menu-scroll.ts';

const inside = { connected: true, insideScroller: true };

describe('isReaderDriven', () => {
  it('is false with no input, true inside the window, false after it', () => {
    expect(isReaderDriven(null, 5000)).toBe(false);
    expect(isReaderDriven(5000, 5000 + READER_INPUT_WINDOW_MS)).toBe(true);
    expect(isReaderDriven(5000, 5000 + READER_INPUT_WINDOW_MS + 1)).toBe(false);
  });
});

describe('decideScroll', () => {
  const origin = { x: 10, y: 100 };

  it('dismisses when no trigger is known', () => {
    expect(decideScroll({ trigger: null, readerDriven: false, origin: null, current: null })).toEqual({
      kind: 'dismiss',
    });
  });

  it('ignores a scroll of something that does not hold the trigger', () => {
    const facts = { trigger: { connected: true, insideScroller: false }, origin, current: origin };
    expect(decideScroll({ ...facts, readerDriven: false })).toEqual({ kind: 'ignore' });
    expect(decideScroll({ ...facts, readerDriven: true })).toEqual({ kind: 'ignore' });
  });

  it('dismisses a reader-driven scroll that holds the trigger', () => {
    expect(decideScroll({ trigger: inside, readerDriven: true, origin, current: origin })).toEqual({ kind: 'dismiss' });
  });

  it('follows a programmatic scroll by the trigger delta', () => {
    expect(decideScroll({ trigger: inside, readerDriven: false, origin, current: { x: 10, y: 60 } })).toEqual({
      kind: 'follow',
      dx: 0,
      dy: -40,
    });
  });

  it('dismisses a programmatic scroll once the trigger is gone or unmeasured', () => {
    expect(
      decideScroll({ trigger: { connected: false, insideScroller: true }, readerDriven: false, origin, current: null }),
    ).toEqual({ kind: 'dismiss' });
    expect(decideScroll({ trigger: inside, readerDriven: false, origin: null, current: origin })).toEqual({
      kind: 'dismiss',
    });
  });
});
