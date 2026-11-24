import { describe, expect, test } from 'bun:test';
import {
  IMAGE_MODELS,
  IMAGE_SIZES,
  MAX_SPEECH_CHARS,
  MUSIC_TABLE,
  priceImage,
  priceMusic,
  priceSfx,
  priceSpeech,
  SFX_TABLE,
  SPEECH_MODELS,
  usdWords,
} from '../../contract/index.ts';

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

describe('every sound price cites the page it was read from', () => {
  test('a source and a positive table price each', () => {
    for (const model of Object.values(SPEECH_MODELS)) {
      expect(model.source).toMatch(/^https:\/\/elevenlabs\.io\//u);
      expect(model.tableMicroUsdPer1kChars).toBeGreaterThan(0);
    }
    for (const table of [SFX_TABLE, MUSIC_TABLE]) {
      expect(table.source).toMatch(/^https:\/\/fal\.ai\//u);
      expect(table.tableMicroUsd).toBeGreaterThan(0);
    }
  });
});

describe('priceSpeech', () => {
  test('is the listed rate per 1 000 characters of text, rounded up', () => {
    expect(priceSpeech(SPEECH_MODELS.flash, 1_000)).toEqual({ ok: true, microUsd: 50_000, from: 'table' });
    expect(priceSpeech(SPEECH_MODELS.multilingual, 1_000)).toEqual({ ok: true, microUsd: 100_000, from: 'table' });
    expect(priceSpeech(SPEECH_MODELS.flash, 19)).toEqual({ ok: true, microUsd: 950, from: 'table' });
    expect(priceSpeech(SPEECH_MODELS.flash, 1)).toEqual({ ok: true, microUsd: 50, from: 'table' });
  });
  test('the longest text is well under the dollar that asks the owner', () => {
    const longest = priceSpeech(SPEECH_MODELS.multilingual, MAX_SPEECH_CHARS);
    expect(longest.ok && longest.microUsd).toBe(150_000);
  });
});

describe('priceSfx', () => {
  test('a per-second rate is exact for the length asked, rounded up', () => {
    expect(priceSfx(5)).toEqual({ ok: true, microUsd: 10_000, from: 'table' });
    expect(priceSfx(0.5)).toEqual({ ok: true, microUsd: 1_000, from: 'table' });
    expect(priceSfx(5, { unitPrice: 0.0031, unit: 'seconds' })).toEqual({ ok: true, microUsd: 15_500, from: 'fal' });
  });
  test('a per-minute live rate is read as whole minutes, never under', () => {
    expect(priceSfx(3, { unitPrice: 0.12, unit: 'minute' })).toEqual({ ok: true, microUsd: 120_000, from: 'fal' });
  });
  test('a picture’s unit, a negative rate or a rate that is not a number is refused', () => {
    expect(priceSfx(5, { unitPrice: 0.01, unit: 'megapixels' }).ok).toBe(false);
    expect(priceSfx(5, { unitPrice: 0.01, unit: 'image' }).ok).toBe(false);
    expect(priceSfx(5, { unitPrice: -1, unit: 'seconds' }).ok).toBe(false);
    expect(priceSfx(5, { unitPrice: Number.NaN, unit: 'seconds' }).ok).toBe(false);
  });
});

describe('priceMusic', () => {
  test('fal rounds up to the whole minute, so ten seconds costs what sixty does', () => {
    expect(priceMusic(10)).toEqual({ ok: true, microUsd: 600_000, from: 'table' });
    expect(priceMusic(60)).toEqual({ ok: true, microUsd: 600_000, from: 'table' });
    expect(priceMusic(61)).toEqual({ ok: true, microUsd: 1_200_000, from: 'table' });
  });
  test('a per-second live rate is priced from the whole minute too', () => {
    expect(priceMusic(10, { unitPrice: 0.01, unit: 'seconds' })).toEqual({ ok: true, microUsd: 600_000, from: 'fal' });
    expect(priceMusic(10, { unitPrice: 0.5, unit: 'audio minute' })).toEqual({
      ok: true,
      microUsd: 500_000,
      from: 'fal',
    });
  });
  test('a unit that is not time is refused', () => {
    expect(priceMusic(10, { unitPrice: 0.5, unit: 'image' }).ok).toBe(false);
  });
  test('an image is never priced by a time unit', () => {
    expect(priceImage(IMAGE_MODELS['flux-schnell'], 'square', { unitPrice: 0.5, unit: 'minutes' }).ok).toBe(false);
  });
});
