import { describe, expect, test } from 'bun:test';
import { marqueeOf, wordCut } from '../../../src/ui/lib/title-marquee.ts';

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

describe('wordCut', () => {
  // Every character is 10px wide, so a box of 150px holds 15 characters.
  const room = (px: number) => (candidate: string) => candidate.length * 10 <= px;
  const TITLE = 'Three answers for the catalog before I can finish';

  test('leaves a title that fits alone', () => {
    expect(wordCut('Short title', room(150))).toBeNull();
  });

  test('ends at the last whole word that fits, then "…"', () => {
    expect(wordCut(TITLE, room(150))).toBe('Three answers…');
    expect(wordCut(TITLE, room(250))).toBe('Three answers for the…');
  });

  test('never ends mid-word, whatever the width', () => {
    const words = new Set(TITLE.split(' '));
    for (let px = 60; px < 480; px += 10) {
      const cut = wordCut(TITLE, room(px));
      if (cut === null) continue;
      expect(cut.endsWith('…')).toBe(true);
      expect(
        cut
          .slice(0, -1)
          .split(' ')
          .every(word => words.has(word)),
      ).toBe(true);
      expect(TITLE.startsWith(cut.slice(0, -1))).toBe(true);
    }
  });

  test('gives up (the box ends it) when not even the first word fits, or there is only one word', () => {
    expect(wordCut(TITLE, room(20))).toBeNull();
    expect(wordCut('Supercalifragilistic', room(50))).toBeNull();
  });
});
