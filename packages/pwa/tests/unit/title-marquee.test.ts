import { describe, expect, test } from 'bun:test';
import { marqueeOf } from '../../src/lib/title-marquee.ts';

describe('when a one-line title scrolls', () => {
  test('a title that fits its box does not scroll, nor does one within a pixel of it', () => {
    expect(marqueeOf(120, 200)).toBeNull();
    expect(marqueeOf(200, 200)).toBeNull();
    expect(marqueeOf(201, 200)).toBeNull();
  });

  test('a longer title scrolls exactly as far as it overflows, plus a little air', () => {
    expect(marqueeOf(500, 200)).toEqual({ distance: 308, seconds: 20 });
  });

  test('no title scrolls faster than a reader can follow, or for less than a slow breath', () => {
    expect(marqueeOf(260, 200)?.seconds).toBe(8);
    expect(marqueeOf(10_000, 200)?.seconds).toBeGreaterThan(marqueeOf(500, 200)?.seconds ?? 0);
  });

  test('a box that has no width yet (not laid out) scrolls nothing', () => {
    expect(marqueeOf(500, 0)).toBeNull();
  });
});
