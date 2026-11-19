import { describe, expect, it } from 'bun:test';
import {
  type Known,
  type Measured,
  type Miss,
  misses,
  staleKnown,
  verdictOf,
  type Where,
} from '../support/theme-matrix.ts';

const clean: Measured = {
  text: [{ what: 'Body', ratio: 7 }],
  edge: [{ what: 'Name edge', ratio: 3.4 }],
  focus: [{ what: 'Primary', drawn: true, width: 2, ratio: 4 }],
  overflow: [],
  fonts: [{ family: 'Inter', loaded: true }],
};
const where: Where = { viewport: '390', style: 'neo', palette: 'ma', mode: 'dark' };

describe('what the theme matrix calls a miss', () => {
  it('a clean specimen has none', () => {
    expect(misses(clean)).toEqual([]);
  });

  it('text under 4.5:1, an edge under 3:1, and a ring under 3:1 each miss; the floors themselves pass', () => {
    const found = misses({
      ...clean,
      text: [
        { what: 'Weak', ratio: 4.49 },
        { what: 'Floor', ratio: 4.5 },
      ],
      edge: [{ what: 'Name edge', ratio: 2.99 }],
      focus: [{ what: 'Primary', drawn: true, width: 2, ratio: 2.5 }],
    });
    expect(found.map(miss => `${miss.check}:${miss.what}`)).toEqual([
      'text:Weak',
      'edge:Name edge',
      'focus:Primary ring colour',
    ]);
  });

  it('a ring that is not drawn, or is thinner than 2px, misses', () => {
    expect(
      misses({
        ...clean,
        focus: [
          { what: 'A', drawn: false, width: 0, ratio: 0 },
          { what: 'B', drawn: true, width: 1, ratio: 9 },
        ],
      }).map(miss => miss.got),
    ).toEqual(['none drawn', '1px']);
  });

  it('overflow and an unloaded face miss', () => {
    const found = misses({
      ...clean,
      overflow: [{ what: 'Primary', right: 412.4, limit: 390 }],
      fonts: [{ family: 'Archivo Black', loaded: false }],
    });
    expect(found.map(miss => miss.check)).toEqual(['overflow', 'fonts']);
  });
});

describe('what a miss costs (the owner: "its ok some style fights readability rules")', () => {
  const text: Miss = { check: 'text', what: 'Body', got: '2.00:1', need: '>=4.5:1' };
  const edge: Miss = { check: 'edge', what: 'Name edge', got: '1.20:1', need: '>=3:1' };
  const ring: Miss = { check: 'focus', what: 'Primary ring', got: 'none drawn', need: '>=2px' };
  const wide: Miss = { check: 'overflow', what: 'Primary', got: '412px', need: '<=390px' };
  const face: Miss = { check: 'fonts', what: 'Inter', got: 'not loaded', need: 'loaded' };

  it('a normal style fails on every kind of miss', () => {
    for (const miss of [text, edge, ring, wide, face]) expect(verdictOf(false, where, miss, []).verdict).toBe('fail');
  });

  it('a loud style only warns on contrast', () => {
    expect(verdictOf(true, where, text, []).verdict).toBe('warn');
    expect(verdictOf(true, where, edge, []).verdict).toBe('warn');
  });

  it('a loud style still fails on the focus ring, on overflow and on an unloaded face', () => {
    for (const miss of [ring, wide, face]) expect(verdictOf(true, where, miss, []).verdict).toBe('fail');
  });
});

describe('the known-misses ledger', () => {
  const ledger: readonly Known[] = [
    { style: ['studio'], check: 'focus', what: /^Name/u, why: 'a field with a 1px border' },
    { palette: ['ledger'], mode: 'dark', check: 'text', what: /^ok$/u, why: 'a status ink' },
  ];
  const ring: Miss = { check: 'focus', what: 'Name (border) ring', got: '1px', need: '>=2px' };

  it('covers exactly the style, palette, mode and check it names', () => {
    const studio: Where = { ...where, style: 'studio' };
    expect(verdictOf(false, studio, ring, ledger)).toEqual({ verdict: 'known', known: 0 });
    expect(verdictOf(false, { ...studio, style: 'neo' }, ring, ledger).verdict).toBe('fail');
    const ink: Miss = { check: 'text', what: 'ok', got: '4.15:1', need: '>=4.5:1' };
    const dark: Where = { ...where, palette: 'ledger', mode: 'dark' };
    expect(verdictOf(false, dark, ink, ledger)).toEqual({ verdict: 'known', known: 1 });
    expect(verdictOf(false, { ...dark, mode: 'light' }, ink, ledger).verdict).toBe('fail');
    expect(verdictOf(false, { ...dark, palette: 'ma' }, ink, ledger).verdict).toBe('fail');
  });

  it('a row nothing matched is stale and must be deleted', () => {
    expect(staleKnown(ledger, new Set([0]))).toEqual([ledger[1] as Known]);
    expect(staleKnown(ledger, new Set([0, 1]))).toEqual([]);
  });
});
