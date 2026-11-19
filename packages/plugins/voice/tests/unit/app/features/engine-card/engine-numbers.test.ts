/**
 * The bars' numbers: every one is pinned back to the sentence `research-numbers.ts` ships for the same engine, and the
 * mapping from a measurement to a bar length is checked at its ends, so a changed benchmark cannot silently change a card.
 */

import { describe, expect, it } from 'bun:test';
import {
  accuracyValue,
  BROWSER_BARS,
  barsText,
  ENGINE_LINES,
  ENGINE_MEASURES,
  engineBars,
  KEY_TERM_COUNT,
  MIN_BAR,
  SIZE_FULL_BYTES,
  sizeValue,
  SPEED_SLOWEST_SECONDS,
  speedValue,
} from '../../../../../app/features/engine-card/engine-numbers.ts';
import {
  modelDownloadBytes,
  ON_DEVICE_MODEL_IDS,
  ON_DEVICE_MODELS,
  onDeviceModel,
} from '../../../../../app/lib/stt/model-catalog.ts';

const modelOf = (id: string) => {
  const model = onDeviceModel(id);
  if (model === null) throw new Error(`no model ${id}`);
  return model;
};

describe('the engine measures', () => {
  it('has a measure and a one-line description for every engine in the catalog, and no others', () => {
    expect(Object.keys(ENGINE_MEASURES).sort()).toEqual([...ON_DEVICE_MODEL_IDS].sort());
    expect(Object.keys(ENGINE_LINES).sort()).toEqual([...ON_DEVICE_MODEL_IDS].sort());
  });

  it('matches the sentences research-numbers.ts ships: seconds from Stop to text, and key terms of 33', () => {
    for (const model of ON_DEVICE_MODELS) {
      const measure = ENGINE_MEASURES[model.id];
      const speed = model.measured?.speed ?? '';
      const accuracy = model.measured?.accuracy ?? '';
      expect(speed).toContain(`${measure.stopToTextSeconds.toFixed(1)} s`);
      expect(accuracy).toContain(`${measure.keyTerms} of ${KEY_TERM_COUNT} key terms`);
    }
  });

  it('keeps every one-line description to a single short line', () => {
    for (const line of Object.values(ENGINE_LINES)) expect(line.length).toBeLessThanOrEqual(44);
  });
});

describe('the bar lengths', () => {
  it('speed falls in a straight line from full at 0 s to the minimum at the slowest wait', () => {
    expect(speedValue(0)).toBe(1);
    expect(speedValue(SPEED_SLOWEST_SECONDS)).toBe(MIN_BAR);
    expect(speedValue(60)).toBe(MIN_BAR);
    expect(speedValue(0.4)).toBeGreaterThan(speedValue(1.7));
    expect(speedValue(1.7)).toBeGreaterThan(speedValue(7.1));
  });

  it('accuracy is the share of key terms caught, and size the share of the largest download', () => {
    expect(accuracyValue(KEY_TERM_COUNT)).toBe(1);
    expect(accuracyValue(0)).toBe(MIN_BAR);
    expect(accuracyValue(30)).toBeGreaterThan(accuracyValue(17));
    expect(sizeValue(SIZE_FULL_BYTES * 2)).toBe(1);
    expect(sizeValue(86_000_000)).toBeLessThan(sizeValue(683_000_000));
  });

  it('draws three bars per on-device engine, in range, with the real download size in words', () => {
    for (const model of ON_DEVICE_MODELS) {
      const bars = engineBars(model);
      expect(bars.map(bar => bar.label)).toEqual(['Speed', 'Accuracy', 'Size']);
      for (const bar of bars) {
        expect(bar.value).not.toBeNull();
        expect(bar.value as number).toBeGreaterThanOrEqual(MIN_BAR);
        expect(bar.value as number).toBeLessThanOrEqual(1);
      }
      expect(bars[2]?.text).toBe(`${Math.round(modelDownloadBytes(model) / 1_000_000)} MB`);
    }
  });

  it('gives the fast engine a longer speed bar than the slow one, and the larger download a longer size bar', () => {
    const zipformer = engineBars(modelOf('sherpa-zipformer-en'));
    const whisperBase = engineBars(modelOf('whisper-base-en'));
    const parakeet = engineBars(modelOf('parakeet'));
    expect(zipformer[0]?.value as number).toBeGreaterThan(whisperBase[0]?.value as number);
    expect(parakeet[2]?.value as number).toBeGreaterThan(zipformer[2]?.value as number);
  });

  it('says what the browser voice did not measure instead of drawing a number for it', () => {
    expect(BROWSER_BARS.find(bar => bar.label === 'Accuracy')?.value).toBeNull();
    expect(barsText(BROWSER_BARS)).toBe('Speed Live. Accuracy Unrated. Size None.');
  });

  it('writes the bars as one sentence for a screen reader', () => {
    expect(barsText(engineBars(modelOf('sherpa-zipformer-en')))).toBe('Speed 0.4 s. Accuracy 52%. Size 86 MB.');
  });
});
