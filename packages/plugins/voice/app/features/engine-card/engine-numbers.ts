/**
 * WHAT THE THREE BARS MEAN — the one table that turns the engine research into the card's Speed / Accuracy / Size bars.
 *
 * Every number below is read from the benchmark `lib/stt/research-numbers.ts` documents (on-device speech research of
 * 2026-10-22, headless Chrome with the CPU slowed four times to stand in for a mid-range phone), and the unit suite
 * pins each one back to the sentence that file ships, so the two cannot drift apart:
 *
 *   - SPEED     the wait from Stop to the text for a ~5 s take, in seconds ("0.4 s from Stop to text"). Less is longer
 *               on the bar: 0 s is full, `SPEED_SLOWEST_SECONDS` or more is nearly empty.
 *   - ACCURACY  how many of the 33 technical key terms (`kubectl`, `useEffect`, `onnxruntime`…) came out right in the 10
 *               synthesised technical dictations. This is the catch rate, not the everyday word error rate: technical
 *               words are what a Ferretry person dictates, and everyday speech is near-perfect for every engine.
 *   - SIZE      the whole first download in bytes (`modelDownloadBytes`: the model's files plus its runtime). More is
 *               longer on the bar, and the megabytes are always written beside it, so "full" never means "good".
 *
 * An engine with no measurement (the browser's own) says "not measured" instead of drawing a number it does not have.
 */

import { modelDownloadBytes, type OnDeviceModel, type OnDeviceModelId } from '../../lib/stt/model-catalog.ts';
import { formatMegabytes } from '../../lib/stt/model-store.ts';

/** What was measured for one engine, copied from `research-numbers.ts`. */
export interface EngineMeasure {
  /** Seconds from Stop to the text on the phone-speed CPU. */
  readonly stopToTextSeconds: number;
  /** Technical key terms caught, of {@link KEY_TERM_COUNT}. */
  readonly keyTerms: number;
}

export const KEY_TERM_COUNT = 33;
/** A wait this long or longer draws the shortest speed bar. */
export const SPEED_SLOWEST_SECONDS = 15;
/** A download this big fills the size bar (the largest catalog engine is 683 MB). */
export const SIZE_FULL_BYTES = 700_000_000;
/** Every non-empty bar is at least this long, so a small value is still a visible bar. */
export const MIN_BAR = 0.05;

export const ENGINE_MEASURES: Readonly<Record<OnDeviceModelId, EngineMeasure>> = {
  'sherpa-zipformer-en': { stopToTextSeconds: 0.4, keyTerms: 17 },
  'moonshine-tiny-en': { stopToTextSeconds: 2.0, keyTerms: 23 },
  'moonshine-base-en': { stopToTextSeconds: 3.4, keyTerms: 29 },
  'whisper-tiny-en': { stopToTextSeconds: 7.6, keyTerms: 30 },
  'whisper-base-en': { stopToTextSeconds: 14.3, keyTerms: 28 },
  'parakeet-tdt-110m': { stopToTextSeconds: 1.7, keyTerms: 27 },
  'vosk-small-en': { stopToTextSeconds: 2.7, keyTerms: 19 },
  parakeet: { stopToTextSeconds: 7.1, keyTerms: 29 },
};

/** The one sentence under each engine's name: what it is for, in plain words. */
export const ENGINE_LINES: Readonly<Record<OnDeviceModelId, string>> = {
  'sherpa-zipformer-en': 'Fastest. Words appear as you speak.',
  'moonshine-tiny-en': 'Small and quick. Good for short notes.',
  'moonshine-base-en': 'Balanced. Good with technical words.',
  'whisper-tiny-en': 'Small download, slower after Stop.',
  'whisper-base-en': 'Careful, but slow on a phone.',
  'parakeet-tdt-110m': 'Accurate and light. The phone default.',
  'vosk-small-en': 'Smallest. Best for plain sentences.',
  parakeet: 'Most accurate. Wants a laptop.',
};

/** One bar: its label, how long it is (0–1, or `null` when nothing was measured), and the words beside it. */
export interface EngineBar {
  readonly label: 'Speed' | 'Accuracy' | 'Size';
  readonly value: number | null;
  /** The value in words ("0.4 s", "52%", "86 MB"); also the bar's text equivalent. */
  readonly text: string;
}

const clamp = (value: number): number => Math.min(1, Math.max(MIN_BAR, value));

/** Speed bar length: 1 at 0 s, falling in a straight line to the minimum at {@link SPEED_SLOWEST_SECONDS}. */
export const speedValue = (seconds: number): number => clamp(1 - seconds / SPEED_SLOWEST_SECONDS);

/** Accuracy bar length: the share of the technical key terms caught. */
export const accuracyValue = (keyTerms: number): number => clamp(keyTerms / KEY_TERM_COUNT);

/** Size bar length: the download against {@link SIZE_FULL_BYTES}. */
export const sizeValue = (bytes: number): number => clamp(bytes / SIZE_FULL_BYTES);

const seconds = (value: number): string => `${value.toFixed(1)} s`;

/** The three bars of an on-device engine, from the table above and the catalog's real download size. */
export function engineBars(model: OnDeviceModel): readonly EngineBar[] {
  const measure = ENGINE_MEASURES[model.id];
  const bytes = modelDownloadBytes(model);
  return [
    { label: 'Speed', value: speedValue(measure.stopToTextSeconds), text: seconds(measure.stopToTextSeconds) },
    {
      label: 'Accuracy',
      value: accuracyValue(measure.keyTerms),
      text: `${Math.round((measure.keyTerms / KEY_TERM_COUNT) * 100)}%`,
    },
    { label: 'Size', value: sizeValue(bytes), text: formatMegabytes(bytes) },
  ];
}

/** The browser's own recognition: words come live and nothing downloads, but nobody measured how well it hears. */
export const BROWSER_BARS: readonly EngineBar[] = [
  { label: 'Speed', value: null, text: 'Live' },
  { label: 'Accuracy', value: null, text: 'Unrated' },
  { label: 'Size', value: 0, text: 'None' },
];

/** A bar group's text equivalent for a screen reader: "Speed 0.4 s. Accuracy 52%. Size 86 MB." */
export const barsText = (bars: readonly EngineBar[]): string => bars.map(bar => `${bar.label} ${bar.text}.`).join(' ');
