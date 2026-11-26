import { describe, expect, it } from 'bun:test';
import { type Corners, outsideCurveBy, type RawBox, roundMisses } from '../support/browser/round-safe.ts';

const round = (r: number): Corners => ({
  tl: { x: r, y: r },
  tr: { x: r, y: r },
  br: { x: r, y: r },
  bl: { x: r, y: r },
});
const rect = { left: 0, top: 0, right: 200, bottom: 100 };

describe('outsideCurveBy', () => {
  it('is 0 or less for a point on a straight edge and for a point inside the arc', () => {
    expect(outsideCurveBy(100, 0, rect, round(20))).toBeLessThanOrEqual(0);
    expect(outsideCurveBy(20, 20, rect, round(20))).toBeLessThanOrEqual(0);
    expect(outsideCurveBy(8, 8, rect, round(20))).toBeLessThanOrEqual(0);
  });

  it('is positive for the square corner of a rounded box, by the gap to the arc', () => {
    // The arc of a 20px corner is 20 * (sqrt(2) - 1) = 8.28px from the square corner along the diagonal.
    expect(outsideCurveBy(0, 0, rect, round(20))).toBeCloseTo(8.28, 1);
    expect(outsideCurveBy(200, 100, rect, round(20))).toBeCloseTo(8.28, 1);
  });

  it('says 0 for a square box whatever the point', () => {
    expect(outsideCurveBy(0, 0, rect, round(0))).toBe(0);
  });

  it('reads an elliptical corner by its own two radii', () => {
    const wide: Corners = { ...round(0), tl: { x: 40, y: 10 } };
    expect(outsideCurveBy(0, 0, rect, wide)).toBeGreaterThan(0);
    expect(outsideCurveBy(40, 0, rect, wide)).toBeLessThanOrEqual(0);
  });
});

describe('roundMisses', () => {
  const box = (radii: Corners, leaves: RawBox['leaves']): RawBox => ({ what: 'banner', inner: rect, radii, leaves });

  it('passes a line of text whose corners sit inside the inner curve', () => {
    const text = { what: 'text "ok"', kind: 'text' as const, rect: { left: 14, top: 14, right: 150, bottom: 34 } };
    expect(roundMisses([box(round(20), [text])])).toEqual([]);
  });

  it('fails text that runs into a pill-sized radius, naming the corner and how far', () => {
    // The owner's banner: a 100px-tall box with a stadium radius and a line of text 12px in.
    const text = { what: 'text "Pair"', kind: 'text' as const, rect: { left: 12, top: 12, right: 150, bottom: 32 } };
    const found = roundMisses([box(round(50), [text])]);
    expect(found.map(m => m.corner)).toContain('tl');
    expect(found[0]?.outsideBy).toBeGreaterThan(3);
    expect(found[0]?.box).toBe('banner');
  });

  it('judges a nested rounded button by its own arc, not its square corner', () => {
    // A pill button 6px in from a 20px corner: its square corner is outside, its own 45-degree arc point is inside.
    const button = {
      what: 'button "Go"',
      kind: 'painted' as const,
      rect: { left: 4, top: 50, right: 80, bottom: 94 },
      radii: round(22),
    };
    expect(roundMisses([box(round(20), [button])])).toEqual([]);
    expect(roundMisses([box(round(20), [{ ...button, radii: round(0) }])]).map(m => m.corner)).toEqual(['bl']);
  });

  it('ignores sub-pixel noise', () => {
    const text = { what: 'text', kind: 'text' as const, rect: { left: 5.9, top: 5.9, right: 100, bottom: 30 } };
    expect(roundMisses([box(round(20), [text])])).toEqual([]);
  });

  it('fails in-flow content that is only partly inside its box: a button 4px past the left edge near the bottom-left corner', () => {
    // The owner's banner with "Pair again" moved 18px left and 8px down: its bottom-left corner is past the curve AND past the edge.
    const button = {
      what: 'button "Pair again"',
      kind: 'painted' as const,
      rect: { left: -4, top: 50, right: 80, bottom: 98 },
      radii: round(22),
      inFlow: true,
    };
    const found = roundMisses([{ ...box(round(20), [button]), outer: rect }]);
    expect(found.map(m => m.corner)).toContain('left');
    expect(found.find(m => m.corner === 'left')?.outsideBy).toBeCloseTo(4, 0);
  });

  it('fails in-flow content that pokes out of a straight edge, away from every corner', () => {
    const text = {
      what: 'text "long"',
      kind: 'text' as const,
      rect: { left: 60, top: 40, right: 230, bottom: 60 },
      inFlow: true,
    };
    const found = roundMisses([{ ...box(round(20), [text]), outer: rect }]);
    expect(found.map(m => m.corner)).toEqual(['right']);
  });

  it('does not call a protrusion for content that is out of flow or cut by its box', () => {
    const badge = {
      what: 'badge',
      kind: 'painted' as const,
      rect: { left: 180, top: 40, right: 230, bottom: 60 },
      radii: round(10),
      inFlow: false,
    };
    expect(roundMisses([{ ...box(round(20), [badge]), outer: rect }])).toEqual([]);
  });
});
