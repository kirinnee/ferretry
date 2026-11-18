import { describe, expect, test } from 'bun:test';
import {
  clampTransform,
  DOUBLE_TAP_SCALE,
  distance,
  fittedSize,
  IDENTITY,
  MAX_SCALE,
  maxScaleFor,
  midpoint,
  neighbour,
  panBy,
  restingSize,
  SWIPE_DISTANCE,
  swipeStep,
  toggleZoom,
  wheelScale,
  zoomAround,
} from '../../../src/ui/image-viewer-model.ts';

const stage = { width: 400, height: 800 };

describe('fittedSize', () => {
  test('contains a wide picture by its width and a tall one by its height', () => {
    expect(fittedSize({ width: 1000, height: 500 }, stage)).toEqual({ width: 400, height: 200 });
    expect(fittedSize({ width: 500, height: 2000 }, stage)).toEqual({ width: 200, height: 800 });
  });

  test('upscales a small picture to fill the stage', () => {
    expect(fittedSize({ width: 40, height: 80 }, stage)).toEqual({ width: 400, height: 800 });
  });

  test('is empty while either size is unknown', () => {
    expect(fittedSize({ width: 0, height: 10 }, stage)).toEqual({ width: 0, height: 0 });
    expect(fittedSize({ width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
  });
});

describe('clampTransform', () => {
  const fitted = { width: 400, height: 200 };

  test('keeps an unzoomed picture centred', () => {
    expect(clampTransform({ scale: 1, x: 90, y: 90 }, fitted, stage)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  test('lets a zoomed picture pan only as far as its own edge', () => {
    expect(clampTransform({ scale: 3, x: 999, y: 999 }, fitted, stage)).toEqual({ scale: 3, x: 400, y: 0 });
    expect(clampTransform({ scale: 3, x: -999, y: 0 }, fitted, stage).x).toBe(-400);
  });

  test('holds the scale between fit and the maximum', () => {
    expect(clampTransform({ scale: 0.2, x: 0, y: 0 }, fitted, stage).scale).toBe(1);
    expect(clampTransform({ scale: 99, x: 0, y: 0 }, fitted, stage).scale).toBe(MAX_SCALE);
  });
});

describe('zoomAround', () => {
  const fitted = { width: 400, height: 800 };

  test('keeps the point under the finger where it was', () => {
    const focus = { x: 100, y: 50 };
    const next = zoomAround(IDENTITY, 2, focus, fitted, stage);
    expect(next.scale).toBe(2);
    // The point under the focus is at (focus - translate) / scale in picture space; it must not move.
    expect((focus.x - next.x) / next.scale).toBeCloseTo(focus.x, 5);
    expect((focus.y - next.y) / next.scale).toBeCloseTo(focus.y, 5);
  });

  test('never zooms out past fit', () => {
    expect(zoomAround({ scale: 2, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }, fitted, stage)).toEqual(IDENTITY);
  });
});

describe('panBy and toggleZoom', () => {
  const fitted = { width: 400, height: 800 };

  test('a pan is clamped to the zoomed picture', () => {
    expect(panBy({ scale: 2, x: 0, y: 0 }, 500, 0, fitted, stage).x).toBe(200);
  });

  test('a double tap zooms in on the tapped point, and a second one fits again', () => {
    const zoomed = toggleZoom(IDENTITY, { x: 50, y: 0 }, fitted, stage);
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, fitted, stage)).toEqual(IDENTITY);
  });
});

describe('wheelScale', () => {
  test('scrolling up zooms in, down zooms out, and a trackpad pinch is finer-grained per delta', () => {
    expect(wheelScale(-100, false)).toBeGreaterThan(1);
    expect(wheelScale(100, false)).toBeLessThan(1);
    expect(wheelScale(0, false)).toBe(1);
    expect(wheelScale(-1, true)).toBeGreaterThan(wheelScale(-1, false));
  });
});

describe('swipeStep', () => {
  test('a long, mostly horizontal drag moves to the neighbour on that side', () => {
    expect(swipeStep(IDENTITY, -SWIPE_DISTANCE, 0)).toBe(1);
    expect(swipeStep(IDENTITY, SWIPE_DISTANCE, 5)).toBe(-1);
  });

  test('a short or mostly vertical drag, or any drag on a zoomed picture, asks for nothing', () => {
    expect(swipeStep(IDENTITY, SWIPE_DISTANCE - 1, 0)).toBe(0);
    expect(swipeStep(IDENTITY, SWIPE_DISTANCE, SWIPE_DISTANCE)).toBe(0);
    expect(swipeStep({ scale: 2, x: 0, y: 0 }, -300, 0)).toBe(0);
  });
});

describe('geometry and neighbours', () => {
  test('distance and midpoint of two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 10 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 15 });
  });

  test('neighbour stops at both ends instead of wrapping', () => {
    expect(neighbour(0, -1, 3)).toBeNull();
    expect(neighbour(2, 1, 3)).toBeNull();
    expect(neighbour(1, 1, 3)).toBe(2);
    expect(neighbour(1, -1, 3)).toBe(0);
  });
});

describe('restingSize', () => {
  const square = { width: 400, height: 400 };
  test('fits a large picture and never enlarges a small one past its own pixels', () => {
    expect(restingSize({ width: 800, height: 400 }, square)).toEqual({ width: 400, height: 200 });
    expect(restingSize({ width: 40, height: 80 }, square)).toEqual({ width: 40, height: 80 });
    expect(restingSize({ width: 0, height: 10 }, square)).toEqual({ width: 0, height: 0 });
  });
});

describe('reaching 100% on a big picture (owner: "i need picture that can zoom")', () => {
  const cases = [
    {
      name: '3840x2160 on a 390x700 phone',
      natural: { width: 3840, height: 2160 },
      stage: { width: 390, height: 700 },
    },
    {
      name: '1290x8000 on a 390x700 phone',
      natural: { width: 1290, height: 8000 },
      stage: { width: 390, height: 700 },
    },
    {
      name: '1440x12000 on a 1280x800 desktop',
      natural: { width: 1440, height: 12000 },
      stage: { width: 1280, height: 800 },
    },
  ];
  for (const { name, natural, stage: box } of cases) {
    const fitted = restingSize(natural, box);
    const rest = fitted.width / natural.width;
    const max = maxScaleFor(rest);

    test(`${name}: the cap lets one picture pixel fill one screen pixel, and then some`, () => {
      expect(rest * MAX_SCALE).toBeLessThan(1); // the old cap stopped short of 100%
      expect(max * rest).toBeGreaterThanOrEqual(2 - 1e-9);
    });

    test(`${name}: Actual size reads 100%`, () => {
      const view = zoomAround(IDENTITY, 1 / rest, { x: 0, y: 0 }, fitted, box, max);
      expect(view.scale * rest).toBeCloseTo(1, 6);
    });

    test(`${name}: wheel and pinch can reach 100%`, () => {
      let wheel = IDENTITY;
      for (let i = 0; i < 200 && wheel.scale * rest < 1; i += 1) {
        wheel = zoomAround(wheel, wheel.scale * wheelScale(-100, false), { x: 0, y: 0 }, fitted, box, max);
      }
      expect(wheel.scale * rest).toBeGreaterThanOrEqual(1 - 1e-9);
      const pinch = zoomAround(IDENTITY, 1 * 1000, { x: 10, y: 10 }, fitted, box, max);
      expect(pinch.scale).toBe(max);
      expect(panBy(pinch, 5, 5, fitted, box, max).scale).toBe(max);
    });
  }

  test('a small picture keeps the old ceiling, and a nonsense rest falls back to it', () => {
    expect(maxScaleFor(1)).toBe(MAX_SCALE);
    expect(maxScaleFor(0)).toBe(MAX_SCALE);
    expect(maxScaleFor(Number.NaN)).toBe(MAX_SCALE);
  });
});
