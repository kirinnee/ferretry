import { describe, expect, test } from 'bun:test';
import { type CaptionGeometry, captionScrollTop } from '../../../app/lib/voice-chat/caption-scroll.ts';

/** A box of 6 lines of 30px (180px) over `lines` lines of text, scrolled to `scrollTop`. */
const box = (over: Partial<CaptionGeometry> & { lines?: number } = {}): CaptionGeometry => ({
  top: 0,
  bottom: 30,
  line: 30,
  viewport: 180,
  content: (over.lines ?? 12) * 30,
  scrollTop: 0,
  ...over,
});

describe('captionScrollTop', () => {
  test('leaves a box alone while the sentence is fully in view on a line boundary', () => {
    expect(captionScrollTop(box({ top: 60, bottom: 90 }))).toBe(0);
    expect(captionScrollTop(box({ top: 150, bottom: 180 }))).toBe(0);
    expect(captionScrollTop(box({ top: 240, bottom: 300, scrollTop: 120 }))).toBe(120);
  });

  test('a sentence below the box scrolls to it, with a line of context before it, in whole lines', () => {
    // Line 7 (top 210): start one line earlier, at line 6 => 180.
    expect(captionScrollTop(box({ top: 210, bottom: 240 }))).toBe(180);
    // A sentence that wraps over lines 7-8.
    expect(captionScrollTop(box({ top: 210, bottom: 270 }))).toBe(180);
  });

  test('a sentence above the box scrolls back to it', () => {
    expect(captionScrollTop(box({ top: 30, bottom: 60, scrollTop: 150 }))).toBe(0);
    expect(captionScrollTop(box({ top: 120, bottom: 150, scrollTop: 150 }))).toBe(90);
  });

  test('a sentence as tall as the box starts at the top of the box, with no context line', () => {
    expect(captionScrollTop(box({ top: 210, bottom: 390, lines: 20 }))).toBe(210);
  });

  test('never scrolls past the last whole line', () => {
    expect(captionScrollTop(box({ top: 330, bottom: 360 }))).toBe(180);
  });

  test('a box that fits entirely has nothing to scroll', () => {
    expect(captionScrollTop(box({ lines: 3, top: 60, bottom: 90, viewport: 90 }))).toBe(0);
  });

  test('a box shorter than one line still counts as showing one line', () => {
    expect(captionScrollTop(box({ lines: 2, top: 30, bottom: 60, viewport: 20, content: 60 }))).toBe(30);
  });

  test('a box resting mid-line is brought back onto a line boundary', () => {
    expect(captionScrollTop(box({ top: 90, bottom: 120, scrollTop: 14 }))).toBe(60);
  });

  test('measurements within a fraction of a pixel count as on the boundary', () => {
    expect(captionScrollTop(box({ top: 59.6, bottom: 90.4 }))).toBe(0);
  });

  test('an empty sentence still takes one line', () => {
    expect(captionScrollTop(box({ top: 210, bottom: 210 }))).toBe(180);
  });

  test('says nothing when it cannot measure', () => {
    expect(captionScrollTop(box({ line: Number.NaN }))).toBeNull();
    expect(captionScrollTop(box({ line: 0 }))).toBeNull();
    expect(captionScrollTop(box({ viewport: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(captionScrollTop(box({ top: Number.NaN }))).toBeNull();
  });
});
