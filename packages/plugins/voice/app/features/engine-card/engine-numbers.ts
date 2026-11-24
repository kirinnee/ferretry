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
 * An engine with no 33-term measurement (the Google live transcriber) draws the Speed and Size bars and no Accuracy bar; its
 * accuracy is said in words behind the "i". An engine with no measurement at all (the browser's own) draws no bars at all: its card says so in a sentence instead of
 * drawing empty tracks for numbers it does not have.
 */

import { modelDownloadBytes, type OnDeviceModel, type OnDeviceModelId } from '../../lib/stt/model-catalog.ts';
import { formatMegabytes } from '../../lib/stt/model-store.ts';

/** What was measured for one engine, copied from `research-numbers.ts`. */
export interface EngineMeasure {
  /** Seconds from Stop to the text on the phone-speed CPU. */
  readonly stopToTextSeconds: number;
  /** Technical key terms caught, of {@link KEY_TERM_COUNT}; absent where the engine was not run on that set. */
  readonly keyTerms?: number;
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
  'google-audio-transcriber': { stopToTextSeconds: 8.2 },
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
  'google-audio-transcriber': 'Live words and punctuation. A laptop.',
};

/**
 * The lines cut to what the bars do not already say, for the first-run page where the owner asked for less description
 * ("reduce the amount of description"): speed, accuracy and size are the bars, so a card says nothing more (the demo shows words
 * arriving live or after Stop). The long line and the measured paragraph stay behind the card's "i" and in Settings › Voice.
 */
export const ENGINE_BRIEF_LINES: Readonly<Record<OnDeviceModelId, string>> = {
  'sherpa-zipformer-en': '',
  'moonshine-tiny-en': '',
  'moonshine-base-en': '',
  'whisper-tiny-en': '',
  'whisper-base-en': '',
  'parakeet-tdt-110m': '',
  'vosk-small-en': '',
  parakeet: '',
  'google-audio-transcriber': '',
};

/** One bar: its label, how long it is (0–1), and the words beside it. */
export interface EngineBar {
  readonly label: 'Speed' | 'Accuracy' | 'Size';
  readonly value: number;
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
  const keyTerms = measure.keyTerms;
  return [
    { label: 'Speed', value: speedValue(measure.stopToTextSeconds), text: seconds(measure.stopToTextSeconds) },
    ...(keyTerms === undefined
      ? []
      : [
          {
            label: 'Accuracy',
            value: accuracyValue(keyTerms),
            text: `${Math.round((keyTerms / KEY_TERM_COUNT) * 100)}%`,
          } as const,
        ]),
    { label: 'Size', value: sizeValue(bytes), text: formatMegabytes(bytes) },
  ];
}

/** A bar group's text equivalent for a screen reader: "Speed 0.4 s. Accuracy 52%. Size 86 MB." */
export const barsText = (bars: readonly EngineBar[]): string => bars.map(bar => `${bar.label} ${bar.text}.`).join(' ');

/**
 * The bars as the shared `OptionBars` takes them. `compact` (the first-run page) draws the length alone: the numbers stay in the
 * card's description for a screen reader and behind the "i", and the bar's length is what is seen at a glance.
 */
export const optionBarsOf = (
  bars: readonly EngineBar[],
  compact = false,
): readonly { label: string; value: number; text?: string }[] =>
  bars.map(bar =>
    compact ? { label: bar.label, value: bar.value } : { label: bar.label, value: bar.value, text: bar.text },
  );
