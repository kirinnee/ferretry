import { describe, expect, it } from 'bun:test';
import {
  contrastRatio,
  identity,
  isLargeText,
  type Known,
  luminance,
  type Measured,
  type Miss,
  misses,
  pinnedMisses,
  stalePins,
  verdictOf,
  type Where,
} from '../support/theme-matrix.ts';

const clean: Measured = {
  text: [{ what: 'Body', ratio: 7, px: 16, weight: 400 }],
  edge: [{ what: 'Name edge', ratio: 3.4 }],
  focus: [{ what: 'Primary', reached: true, visible: true, drawn: true, width: 2, ratio: 4 }],
  overflow: [],
  fonts: [{ what: 'Inter 400', loaded: true }],
};
const where: Where = { viewport: '390', style: 'neo', palette: 'ma', mode: 'dark' };
const ring = { reached: true, visible: true, drawn: true, width: 2, ratio: 4 } as const;

describe('the maths', () => {
  it('uses the sRGB knee at 0.04045 (a channel of 10/255 is on the linear segment)', () => {
    // 10/255 = 0.03922: under 0.04045 so linear (/12.92); the old 0.03928 constant would agree here, so pin the edge too.
    expect(luminance(10, 10, 10)).toBeCloseTo(0.03922 / 12.92, 6);
    // 10.3/255 is not an 8-bit value; 0.04045 * 255 = 10.31, so 10 is the last linear channel and 11 the first power-law one.
    expect(luminance(11, 11, 11)).toBeCloseTo(((11 / 255 + 0.055) / 1.055) ** 2.4, 8);
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 10);
    expect(luminance(0, 0, 0)).toBe(0);
  });

  it('black on white is 21:1, the same colour twice is 1:1, and the order does not matter', () => {
    expect(contrastRatio(luminance(255, 255, 255), luminance(0, 0, 0))).toBeCloseTo(21, 8);
    expect(contrastRatio(0.3, 0.3)).toBe(1);
    expect(contrastRatio(0.1, 0.5)).toBe(contrastRatio(0.5, 0.1));
  });
});

describe('WCAG large text', () => {
  it('is 24px or more, or 18.66px or more AND bold; nothing smaller, and 18.66px regular is not large', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 700)).toBe(true);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.66, 600)).toBe(false);
    expect(isLargeText(18.65, 700)).toBe(false);
    expect(isLargeText(18.66, 400)).toBe(false);
    expect(isLargeText(16, 700)).toBe(false);
  });

  it('large text needs only 3:1; everything else 4.5:1', () => {
    const found = misses({
      ...clean,
      text: [
        { what: 'Big 3.1', ratio: 3.1, px: 24, weight: 400 },
        { what: 'Big 2.9', ratio: 2.9, px: 24, weight: 400 },
        { what: 'Bold 3.1', ratio: 3.1, px: 19, weight: 700 },
        { what: 'Small 3.1', ratio: 3.1, px: 16, weight: 700 },
      ],
    });
    expect(found.map(miss => `${miss.what} ${miss.need}`)).toEqual(['Big 2.9 >=3:1', 'Small 3.1 >=4.5:1']);
  });
});

describe('what the theme matrix calls a miss', () => {
  it('a clean specimen has none', () => {
    expect(misses(clean)).toEqual([]);
  });

  it('text under 4.5:1, an edge under 3:1, and a ring under 3:1 each miss; the floors themselves pass', () => {
    const found = misses({
      ...clean,
      text: [
        { what: 'Weak', ratio: 4.49, px: 16, weight: 400 },
        { what: 'Floor', ratio: 4.5, px: 16, weight: 400 },
      ],
      edge: [{ what: 'Name edge', ratio: 2.99 }],
      focus: [{ what: 'Primary', ...ring, ratio: 2.5 }],
    });
    expect(found.map(miss => `${miss.check}:${miss.what}`)).toEqual([
      'text:Weak',
      'edge:Name edge',
      'focus:Primary ring colour',
    ]);
  });

  it('a control the keyboard never reached, one that is not :focus-visible, an undrawn ring and a thin ring each miss', () => {
    expect(
      misses({
        ...clean,
        focus: [
          { what: 'Z', ...ring, reached: false },
          { what: 'Y', ...ring, visible: false },
          { what: 'A', ...ring, drawn: false, width: 0 },
          { what: 'B', ...ring, width: 1, ratio: 9 },
        ],
      }).map(miss => miss.got),
    ).toEqual(['not reached by keyboard', 'not :focus-visible', 'none drawn', '1px']);
  });

  it('overflow and an unloaded or undeclared face miss', () => {
    const found = misses({
      ...clean,
      overflow: [{ what: 'Primary', right: 412.4, limit: 390 }],
      fonts: [
        { what: 'Archivo Black 400', loaded: false },
        { what: 'Nope 400', loaded: false, reason: 'no @font-face' },
      ],
    });
    expect(found.map(miss => `${miss.check}:${miss.got}`)).toEqual([
      'overflow:412px',
      'fonts:not loaded',
      'fonts:no @font-face',
    ]);
  });
});

describe('what a miss costs (the owner: "its ok some style fights readability rules")', () => {
  const text: Miss = { check: 'text', what: 'Body', got: '2.00:1', need: '>=4.5:1' };
  const edge: Miss = { check: 'edge', what: 'Name edge', got: '1.20:1', need: '>=3:1' };
  const noRing: Miss = { check: 'focus', what: 'Primary ring', got: 'none drawn', need: '>=2px' };
  const wide: Miss = { check: 'overflow', what: 'Primary', got: '412px', need: '<=390px' };
  const face: Miss = { check: 'fonts', what: 'Inter 400', got: 'not loaded', need: 'loaded' };
  const none = new Map<string, string>();

  it('a normal style fails on every kind of miss', () => {
    for (const miss of [text, edge, noRing, wide, face])
      expect(verdictOf(false, where, miss, none).verdict).toBe('fail');
  });

  it('a loud style only warns on contrast', () => {
    expect(verdictOf(true, where, text, none).verdict).toBe('warn');
    expect(verdictOf(true, where, edge, none).verdict).toBe('warn');
  });

  it('a loud style still fails on the focus ring, on overflow and on an unloaded face', () => {
    for (const miss of [noRing, wide, face]) expect(verdictOf(true, where, miss, none).verdict).toBe('fail');
  });
});

describe('the known-misses ledger', () => {
  const ledger: readonly Known[] = [
    {
      viewports: ['390'],
      styles: ['studio'],
      palettes: ['ma', 'ledger'],
      modes: ['dark'],
      check: 'focus',
      what: 'Name (border) ring',
      why: 'a field with a 1px border',
    },
    {
      viewports: ['1280', '390'],
      styles: ['neo'],
      palettes: ['ledger'],
      modes: ['dark'],
      check: 'text',
      what: 'ok',
      why: 'a status ink',
    },
  ];
  const pins = pinnedMisses(ledger);
  const widthMiss: Miss = { check: 'focus', what: 'Name (border) ring', got: '1px', need: '>=2px' };
  const colourMiss: Miss = { check: 'focus', what: 'Name (border) ring colour', got: '1.50:1', need: '>=3:1' };
  const studio: Where = { viewport: '390', style: 'studio', palette: 'ma', mode: 'dark' };

  it('expands to one exact identity per combination it names, with no wildcard', () => {
    expect([...pins.keys()].sort()).toEqual([
      '1280 | neo | ledger | dark | text | ok',
      '390 | neo | ledger | dark | text | ok',
      '390 | studio | ledger | dark | focus | Name (border) ring',
      '390 | studio | ma | dark | focus | Name (border) ring',
    ]);
  });

  it('covers exactly the width, style, palette, mode, check and text it names', () => {
    expect(verdictOf(false, studio, widthMiss, pins)).toEqual({ verdict: 'known', key: identity(studio, widthMiss) });
    for (const other of [
      { ...studio, viewport: '1280' },
      { ...studio, style: 'neo' },
      { ...studio, palette: 'neo' },
      { ...studio, mode: 'light' },
    ])
      expect(verdictOf(false, other, widthMiss, pins).verdict).toBe('fail');
  });

  it('a NEW ring-colour failure is not waived by the pinned ring-width miss on the same control', () => {
    expect(verdictOf(false, studio, colourMiss, pins).verdict).toBe('fail');
    // and the pin does not soften it for a loud style either: focus is hard.
    expect(verdictOf(true, studio, colourMiss, pins).verdict).toBe('fail');
  });

  it('a pinned contrast miss stays known for a loud style, and a new one only warns', () => {
    const ink: Miss = { check: 'text', what: 'ok', got: '4.15:1', need: '>=4.5:1' };
    const neo: Where = { viewport: '390', style: 'neo', palette: 'ledger', mode: 'dark' };
    expect(verdictOf(true, neo, ink, pins).verdict).toBe('known');
    expect(verdictOf(true, { ...neo, palette: 'ma' }, ink, pins).verdict).toBe('warn');
  });

  it('a pin whose miss was not observed is stale and must be deleted; observing every pin leaves none', () => {
    const seen = new Set([identity(studio, widthMiss)]);
    expect(stalePins(pins, seen)).toEqual([
      '1280 | neo | ledger | dark | text | ok',
      '390 | neo | ledger | dark | text | ok',
      '390 | studio | ledger | dark | focus | Name (border) ring',
    ]);
    expect(stalePins(pins, new Set(pins.keys()))).toEqual([]);
  });

  it('a row that names the same miss twice is refused', () => {
    expect(() => pinnedMisses([...ledger, ...ledger])).toThrow(/twice/u);
  });
});
