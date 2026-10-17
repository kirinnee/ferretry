/**
 * NEAR-LIVE WORDS for Parakeet, which is not a streaming model.
 *
 * While the microphone is open this re-transcribes a rolling window — the audio since the last
 * COMMITTED point, a few seconds of it — every ~1.2 s, and splits what it hears in two:
 *
 *   - COMMITTED words have come back identical from two passes in a row (LocalAgreement-2). They
 *     never change again, and the window moves past the audio they cover, so a long dictation costs
 *     the same per pass as a short one.
 *   - INTERIM words are the rest of the latest pass: shown greyed, free to change on the next one.
 *
 * Stop runs ONE final pass over the uncommitted tail and returns committed + tail. With nothing
 * committed that is exactly today’s single pass over the whole take.
 *
 * A WINDOW ONLY EVER STARTS IN A PAUSE. Parakeet (int8, through parakeet.js) answers NOTHING, or
 * stops part-way, for a large share of windows cut at an arbitrary point in speech — even at a word
 * boundary its own timestamps give (`harness/parakeet-near-live-smoke.ts` measured it, and moving a
 * cut by 10 ms flips the answer). Windows that open in real silence, just before the voice resumes,
 * are the reliable ones. So agreed words commit only up to a QUIET RUN in the audio
 * ({@link quietRuns}), and the next window starts {@link PRE_ROLL_MS} before the voice comes back.
 * Agreed words after the last pause wait for the next one. Word times run early, so a word right
 * at the pause can be committed AND re-heard at the start of the next window; those repeats are
 * dropped.
 *
 * The model can still miss, so an empty answer for a window that holds speech is never read as
 * silence: the words on screen stay and the next pass tries again with more audio, and a final tail
 * that comes back empty falls back to today’s single pass over the whole take — so near-live is
 * never less accurate than it.
 *
 * Never two inferences at once: a pass is scheduled only after the previous one has answered. When
 * a pass takes most of its interval the interval doubles; when a pass takes longer than even the
 * longest interval — or longer than the audio it covers — live words PAUSE for the rest of the take
 * and say so ("live words paused — device too slow") rather than falling further and further
 * behind. A window that grows past its hard bound without a pause to cut at stops live words
 * quietly. Stop still transcribes everything.
 *
 * Pure logic over ports: the microphone, the speech worker and the clock are all injected, so a test
 * drives it with scripted passes and a fake clock.
 */

import { PARAKEET_SAMPLE_RATE } from './audio-capture.ts';

/** One recognised word with its place in the audio, in seconds. */
export interface TimedWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A pass's answer: the text and, when the engine can say, where each word sits. */
export interface TimedTranscript {
  readonly text: string;
  readonly words: readonly TimedWord[];
}

/** What the dictation strip shows while recording. */
export interface NearLiveState {
  /** Words two passes agreed on. They never change again. */
  readonly committed: string;
  /** The latest pass's words after those. Provisional, shown greyed. */
  readonly interim: string;
  /** True once this device proved too slow to keep up; the final pass still runs on Stop. */
  readonly paused: boolean;
}

export const EMPTY_NEAR_LIVE: NearLiveState = Object.freeze({ committed: '', interim: '', paused: false });

/** Said, verbatim, when live words stop for this take. */
export const NEAR_LIVE_PAUSED_COPY = 'live words paused — device too slow';

export interface NearLiveTiming {
  /** How often a pass starts while it keeps up. */
  readonly intervalMs: number;
  /** The slowest the interval may back off to before live words pause. */
  readonly maxIntervalMs: number;
  /** Uncommitted audio longer than this is cut at any pause, agreed or not, to keep passes short. */
  readonly windowMs: number;
  /** Uncommitted audio longer than this with no pause to cut at stops live words for the take. */
  readonly maxWindowMs: number;
  /** A forced cut keeps at least this much audio uncommitted at the end. */
  readonly keepTailMs: number;
  /** A pass with less new audio than this since the last one is skipped. */
  readonly minNewAudioMs: number;
  /** A pass taking more than this share of its interval backs the interval off. */
  readonly backOffShare: number;
}

export const NEAR_LIVE_TIMING: NearLiveTiming = Object.freeze({
  intervalMs: 1_200,
  maxIntervalMs: 4_800,
  windowMs: 6_000,
  maxWindowMs: 16_000,
  keepTailMs: 2_500,
  minNewAudioMs: 500,
  backOffShare: 0.8,
});

/** Energy is measured in frames this long. */
const FRAME_MS = 20;
/** A quiet run at least this long is a pause a window may start in. */
export const MIN_PAUSE_MS = 120;
/** The next window starts this long before the voice resumes after a pause. */
export const PRE_ROLL_MS = 180;
/** The quietest a pause has to be, whatever the noise floor. */
const QUIET_RMS = 0.004;
/** Ambient noise raises the bar: quiet is under this multiple of the window's noise floor. */
const NOISE_MULTIPLIER = 2.8;
/** …but never so far that steady speech with no pause in the window reads as quiet. */
const MAX_QUIET_RMS = 0.015;
/** Below this RMS level a whole window is silence, not speech the model failed to hear. */
const SPEECH_RMS = 0.005;
/** Word times run early: a word timed to start this close before a pause ends belongs after it. */
const WORD_SKEW_S = 0.15;
/** At most this many re-heard committed words are dropped from the start of a window… */
const MAX_REPEAT_WORDS = 3;
/** …and only when they start within this many seconds of the window's start. */
const REPEAT_WITHIN_S = 1;

/** Only a window at least this long can show a device is slower than real time. */
const MIN_REAL_TIME_AUDIO_MS = 3_000;

/** Shorter than this is a tap, not speech: a quarter of a second. */
export const MIN_SPEECH_SAMPLES = PARAKEET_SAMPLE_RATE / 4;

export interface NearLivePorts {
  /** Every sample recorded so far, 16 kHz mono. */
  peek(): Promise<Float32Array>;
  /** One live pass, with word times relative to the start of `samples`. */
  transcribeTimed(samples: Float32Array, signal: AbortSignal): Promise<TimedTranscript>;
  /** The final pass: text only. */
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  onChange(state: NearLiveState): void;
}

/** A word compared across passes: case and surrounding punctuation are not a disagreement. */
const comparable = (word: string): string => word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** How many leading words two passes agree on. */
export function agreedPrefix(previous: readonly TimedWord[], current: readonly TimedWord[]): number {
  let count = 0;
  while (
    count < previous.length &&
    count < current.length &&
    comparable((previous[count] as TimedWord).text) === comparable((current[count] as TimedWord).text)
  )
    count += 1;
  return count;
}

/** Words → one line, the way the strip and the draft read them. */
export const joinWords = (...parts: readonly string[]): string =>
  parts
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');

const rms = (samples: Float32Array, from: number, to: number): number => {
  let energy = 0;
  for (let index = from; index < to; index += 1) energy += (samples[index] as number) ** 2;
  return to > from ? Math.sqrt(energy / (to - from)) : 0;
};

/** Whether some samples are loud enough to hold speech. */
export const hasSpeech = (samples: Float32Array): boolean => rms(samples, 0, samples.length) >= SPEECH_RMS;

/** A stretch of quiet audio, in samples: `[start, end)`. */
export interface QuietRun {
  readonly start: number;
  readonly end: number;
}

/**
 * The pauses in `samples[from, to)`: runs of {@link FRAME_MS} frames quieter than the window's own
 * noise floor allows, at least {@link MIN_PAUSE_MS} long.
 */
export function quietRuns(samples: Float32Array, from: number, to: number): QuietRun[] {
  const frame = msToSamples(FRAME_MS);
  const levels: number[] = [];
  for (let at = from; at + frame <= to; at += frame) levels.push(rms(samples, at, at + frame));
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 10)] ?? 0;
  const quiet = Math.min(MAX_QUIET_RMS, Math.max(QUIET_RMS, floor * NOISE_MULTIPLIER));
  const minFrames = Math.ceil(MIN_PAUSE_MS / FRAME_MS);
  const runs: QuietRun[] = [];
  let runStart = -1;
  levels.forEach((level, index) => {
    if (level < quiet) {
      if (runStart < 0) runStart = index;
    } else {
      if (runStart >= 0 && index - runStart >= minFrames)
        runs.push({ start: from + runStart * frame, end: from + index * frame });
      runStart = -1;
    }
  });
  if (runStart >= 0 && levels.length - runStart >= minFrames)
    runs.push({ start: from + runStart * frame, end: from + levels.length * frame });
  return runs;
}

const samplesToSeconds = (samples: number): number => samples / PARAKEET_SAMPLE_RATE;
function msToSamples(milliseconds: number): number {
  return Math.round((milliseconds * PARAKEET_SAMPLE_RATE) / 1_000);
}

export class NearLiveTranscriber {
  readonly #ports: NearLivePorts;
  readonly #timing: NearLiveTiming;
  readonly #abort = new AbortController();
  readonly #committed: string[] = [];
  /** The sample the next window starts at — always in a pause; everything before is committed. */
  #commitSample = 0;
  /** Samples heard by the last pass, so a pass with nothing new is skipped. */
  #lastPassSamples = 0;
  /** The previous pass's words after the commit point, in take time. */
  #previous: readonly TimedWord[] = [];
  #intervalMs: number;
  #timer: unknown = null;
  #paused = false;
  #stopped = false;

  constructor(ports: NearLivePorts, timing: NearLiveTiming = NEAR_LIVE_TIMING) {
    this.#ports = ports;
    this.#timing = timing;
    this.#intervalMs = timing.intervalMs;
  }

  /** Begin passes. Call once the microphone is open. */
  start(): void {
    this.#schedule(this.#intervalMs);
  }

  /** The interval the next pass waits, after any back-off. */
  get intervalMs(): number {
    return this.#intervalMs;
  }

  /**
   * Stop passes and transcribe what is not committed yet. `samples` is the whole take; a live pass
   * still in flight is not waited for — its answer is dropped, and the worker answers it before the
   * final pass anyway, one at a time.
   */
  async finish(samples: Float32Array): Promise<string> {
    this.#halt();
    const committed = joinWords(...this.#committed);
    const tail = samples.subarray(Math.min(this.#commitSample, samples.length));
    if (tail.length < MIN_SPEECH_SAMPLES) return committed;
    const signal = new AbortController().signal;
    // Nothing committed: exactly today’s single pass over the whole take.
    if (committed === '') return await this.#ports.transcribe(tail.slice(), signal);
    // Otherwise the tail may re-hear the last committed word, so it needs word times too.
    const heard = await this.#ports.transcribeTimed(tail.slice(), signal);
    if (heard.words.length === 0 && hasSpeech(tail)) {
      // A miss on the tail. Rather than drop it, fall back to today’s single pass over the whole
      // take — never worse than it.
      const whole = await this.#ports.transcribe(samples.slice(), signal);
      return whole === '' ? committed : whole;
    }
    const fresh = this.#withoutRepeat(heard.words);
    return joinWords(
      committed,
      fresh.length === heard.words.length ? heard.text : joinWords(...fresh.map(w => w.text)),
    );
  }

  /** Stop passes and drop everything. */
  cancel(): void {
    this.#halt();
  }

  #halt(): void {
    this.#stopped = true;
    this.#abort.abort();
    if (this.#timer !== null) this.#ports.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(milliseconds: number): void {
    if (this.#stopped || this.#paused) return;
    this.#timer = this.#ports.setTimeout(() => {
      this.#timer = null;
      void this.#pass();
    }, milliseconds);
  }

  async #pass(): Promise<void> {
    const startedAt = this.#ports.now();
    let audioMs = 0;
    try {
      const samples = await this.#ports.peek();
      if (this.#stopped) return;
      if (samples.length - this.#lastPassSamples < msToSamples(this.#timing.minNewAudioMs)) {
        this.#schedule(this.#intervalMs);
        return;
      }
      this.#lastPassSamples = samples.length;
      const window = samples.slice(this.#commitSample);
      audioMs = (window.length * 1_000) / PARAKEET_SAMPLE_RATE;
      // Measured before the samples are handed (transferred) to the worker.
      const speech = hasSpeech(window);
      const offset = samplesToSeconds(this.#commitSample);
      const heard = await this.#ports.transcribeTimed(window, this.#abort.signal);
      if (this.#stopped) return;
      if (heard.words.length > 0 || !speech) {
        const words = this.#withoutRepeat(heard.words).map(word => ({
          text: word.text,
          start: word.start + offset,
          end: word.end + offset,
        }));
        this.#absorb(words, samples);
      }
      // Otherwise a miss: the words on screen stay and the next pass tries again with more audio.
      if (audioMs > this.#timing.maxWindowMs) {
        // No pause to cut at for this long: every further pass would cost more. Live words stop
        // quietly; Stop still transcribes everything not committed.
        this.#stopped = true;
        return;
      }
    } catch {
      // A live pass that fails (a recorder that cannot be read mid-take, a worker error) costs only
      // the live words: no more passes, and Stop still transcribes everything not committed.
      this.#stopped = true;
      return;
    }
    this.#pace(this.#ports.now() - startedAt, audioMs);
  }

  /**
   * Word times are coarse and run early, so a word committed at a pause can be heard again at the
   * start of the next window. Drop leading words that repeat the end of what is committed — only
   * close to the window's start, so a real repetition said later ("that that") survives.
   */
  #withoutRepeat(words: readonly TimedWord[]): readonly TimedWord[] {
    const committed = this.#committed;
    for (let count = Math.min(MAX_REPEAT_WORDS, committed.length, words.length); count > 0; count -= 1) {
      const repeated = words.slice(0, count);
      if (
        (repeated[count - 1] as TimedWord).start < REPEAT_WITHIN_S &&
        repeated.every(
          (word, index) => comparable(word.text) === comparable(committed[committed.length - count + index] as string),
        )
      )
        return words.slice(count);
    }
    return words;
  }

  /**
   * LocalAgreement-2, committed only up to a pause. The cut is the LAST pause every word before
   * which is agreed; when the window has outgrown {@link NearLiveTiming.windowMs} it may be any pause
   * that leaves {@link NearLiveTiming.keepTailMs} uncommitted, agreed or not.
   */
  #absorb(words: readonly TimedWord[], samples: Float32Array): void {
    const agreed = agreedPrefix(this.#previous, words);
    const heard = samples.length;
    const forced = ((heard - this.#commitSample) * 1_000) / PARAKEET_SAMPLE_RATE > this.#timing.windowMs;
    const latest = forced ? heard - msToSamples(this.#timing.keepTailMs) : heard;
    // A pause at the very start of the window is where it already begins; it cannot move the cut.
    const runs = quietRuns(samples, this.#commitSample, latest).filter(
      run => run.end - msToSamples(PRE_ROLL_MS) > this.#commitSample,
    );
    for (const run of runs.reverse()) {
      // Word times run early, so a word timed a little before the pause ends may really follow it.
      const boundary = Math.max(samplesToSeconds(run.start), samplesToSeconds(run.end) - WORD_SKEW_S);
      const before = words.filter(word => word.start < boundary).length;
      if (!forced && before > agreed) continue;
      this.#committed.push(...words.slice(0, before).map(word => word.text));
      this.#commitSample = Math.max(run.start, run.end - msToSamples(PRE_ROLL_MS));
      this.#previous = words.slice(before);
      this.#emit();
      return;
    }
    this.#previous = words;
    this.#emit();
  }

  /** Back off, pause, or carry on at the current interval. */
  #pace(elapsedMs: number, audioMs: number): void {
    const timing = this.#timing;
    // Slower than real time, or slower than even the longest interval: the live words could only
    // fall further behind, so they stop for this take. (A very short window says little about real
    // time — the fixed cost of a pass dominates it — so it only backs the interval off.)
    if ((audioMs >= MIN_REAL_TIME_AUDIO_MS && elapsedMs >= audioMs) || elapsedMs > timing.maxIntervalMs) {
      this.#paused = true;
      this.#emit();
      return;
    }
    if (elapsedMs > timing.backOffShare * this.#intervalMs)
      this.#intervalMs = Math.min(this.#intervalMs * 2, timing.maxIntervalMs);
    this.#schedule(Math.max(0, this.#intervalMs - elapsedMs));
  }

  #emit(): void {
    this.#ports.onChange({
      committed: joinWords(...this.#committed),
      interim: joinWords(...this.#previous.map(word => word.text)),
      paused: this.#paused,
    });
  }
}
