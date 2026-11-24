import { describe, expect, test } from 'bun:test';
import { IMAGE_MODELS, IMAGE_SIZES, priceImage, usdWords } from '../../contract/index.ts';

describe('usdWords rounds up, so it never shows less than a call costs', () => {
  test('cents above a cent, a short fraction under it', () => {
    expect(usdWords(26_000)).toBe('$0.03');
    expect(usdWords(10_000)).toBe('$0.01');
    expect(usdWords(1_200_000)).toBe('$1.20');
    expect(usdWords(2_359)).toBe('$0.0024');
    expect(usdWords(3_000)).toBe('$0.003');
  });
});

describe('every model cites the page its price was read from', () => {
  test('a source and a positive table price each', () => {
    for (const model of Object.values(IMAGE_MODELS)) {
      expect(model.source).toMatch(/^https:\/\/fal\.ai\//u);
      expect(model.tableMicroUsd).toBeGreaterThan(0);
    }
  });
});

describe('priceImage', () => {
  test('a megapixel rate is proportional to the picture’s area, rounded up', () => {
    const priced = priceImage(IMAGE_MODELS['flux-dev'], 'square_hd');
    // 1024 × 1024 = 1.048576 MP at $0.025
    expect(priced).toEqual({ ok: true, microUsd: Math.ceil(25_000 * 1.048576), from: 'table' });
  });
  test('fal’s own rate, when it names a unit we can read, replaces the table', () => {
    const priced = priceImage(IMAGE_MODELS['flux-schnell'], 'landscape_4_3', { unitPrice: 0.01, unit: 'image' });
    expect(priced).toEqual({ ok: true, microUsd: 10_000, from: 'fal' });
  });
  test('a per-image rate on a picture over a megapixel is priced as that many megapixels, never less', () => {
    const priced = priceImage(IMAGE_MODELS['flux-schnell'], 'square_hd', { unitPrice: 0.01, unit: 'image' });
    expect(priced.ok && priced.microUsd).toBe(Math.ceil(10_000 * 1.048576));
  });
  test('a live rate in a unit we cannot price is refused, never guessed', () => {
    const priced = priceImage(IMAGE_MODELS['flux-schnell'], 'square', { unitPrice: 0.5, unit: 'second' });
    expect(priced.ok).toBe(false);
  });
  test('a negative or non-number live rate is refused', () => {
    expect(priceImage(IMAGE_MODELS['flux-schnell'], 'square', { unitPrice: -1, unit: 'image' }).ok).toBe(false);
    expect(priceImage(IMAGE_MODELS['flux-schnell'], 'square', { unitPrice: Number.NaN, unit: 'image' }).ok).toBe(false);
  });
  test('every size is within about one megapixel, so the table is a fair floor', () => {
    for (const size of Object.values(IMAGE_SIZES)) expect(size.width * size.height).toBeLessThanOrEqual(1_100_000);
  });
});
