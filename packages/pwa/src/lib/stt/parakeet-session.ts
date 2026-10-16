/**
 * One on-device dictation: open the microphone, record, then transcribe with Parakeet in the speech
 * worker. Audio never leaves this device: the recording goes from the microphone to this page's
 * memory to the worker, and the only thing that comes back is text.
 *
 * It speaks the same contract as the browser-speech session (`browser-recognition.ts`) — `start`,
 * `finish`, `cancel`, and the same callbacks — so `hooks/use-dictation.ts` drives either engine with
 * one state machine. The difference the reader sees is honest: there is no live caption, because
 * Parakeet is not a streaming model; words appear when Stop transcribes the take.
 */

import type { AudioCapturePort, AudioRecording } from './audio-capture.ts';
import { PARAKEET_SAMPLE_RATE } from './audio-capture.ts';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  type BrowserRecognitionSessionOptions,
  browserRecognitionErrorFrom,
} from './browser-recognition.ts';
import { type ParakeetEngine, ParakeetEngineError } from './parakeet-engine.ts';

const MAX_DICTATION_MS = 120_000;
/** Shorter than this is a tap, not speech: a quarter of a second. */
const MIN_SAMPLES = PARAKEET_SAMPLE_RATE / 4;

export interface ParakeetSessionPorts {
  readonly capture: AudioCapturePort;
  readonly engine: Pick<ParakeetEngine, 'preload' | 'transcribe'>;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

type State = 'opening' | 'recording' | 'finishing' | 'finished' | 'failed' | 'cancelled';

/** Engine failures → the dictation panel's vocabulary. */
export const parakeetFailure = (error: unknown): BrowserRecognitionError => {
  if (error instanceof ParakeetEngineError) {
    if (error.code === 'cancelled') return new BrowserRecognitionError('aborted', error.message);
    if (error.code === 'not-installed') return new BrowserRecognitionError('model-not-installed', error.message);
    return new BrowserRecognitionError('recognition-failed', error.message);
  }
  return browserRecognitionErrorFrom(error);
};

export class ParakeetRecognitionSession implements BrowserRecognitionSessionLike {
  readonly #ports: ParakeetSessionPorts;
  readonly #options: BrowserRecognitionSessionOptions;
  readonly #abort = new AbortController();
  #state: State = 'opening';
  #recording: Promise<AudioRecording> | null = null;
  #limitTimer: unknown = null;
  #unwatchHidden: (() => void) | null = null;
  #finishing: Promise<string> | null = null;

  constructor(ports: ParakeetSessionPorts, options: BrowserRecognitionSessionOptions) {
    this.#ports = ports;
    this.#options = options;
  }

  /** Call synchronously from the reader's gesture: the permission prompt is attributed to it. */
  start(): void {
    this.#unwatchHidden = this.#ports.watchHidden(() => {
      if (this.#state !== 'opening' && this.#state !== 'recording') return;
      this.cancel();
      this.#options.onAbort();
    });
    const recording = this.#ports.capture.start();
    this.#recording = recording;
    recording.then(
      opened => {
        if (this.#state === 'cancelled' || this.#state === 'failed') {
          opened.cancel();
          return;
        }
        if (this.#state === 'finishing') return;
        this.#state = 'recording';
        this.#limitTimer = this.#ports.setTimeout(
          () => {
            if (this.#state === 'recording') this.#options.onLimit();
          },
          Math.max(1, this.#options.maxDurationMs ?? MAX_DICTATION_MS),
        );
        this.#options.onStart();
        // Load while the person speaks. A failure here is reported by the transcribe that follows.
        try {
          this.#ports.engine.preload();
        } catch {
          // The same failure reaches `finish`, where the reader sees it.
        }
      },
      (error: unknown) => this.#fail(parakeetFailure(error)),
    );
  }

  finish(): Promise<string> {
    if (this.#finishing !== null) return this.#finishing;
    if (this.#state === 'failed' || this.#state === 'cancelled')
      return Promise.reject(new BrowserRecognitionError('aborted', 'Dictation already ended.'));
    this.#state = 'finishing';
    this.#clearLimit();
    this.#finishing = this.#transcribe().then(
      text => {
        if (this.#state !== 'finishing') throw new BrowserRecognitionError('aborted', 'Dictation was cancelled.');
        this.#state = 'finished';
        this.#cleanup();
        return text;
      },
      (error: unknown) => {
        const failure = parakeetFailure(error);
        if (this.#state === 'finishing') {
          this.#state = failure.code === 'aborted' ? 'cancelled' : 'failed';
          this.#cleanup();
        }
        throw failure;
      },
    );
    return this.#finishing;
  }

  cancel(): void {
    if (this.#state === 'finished' || this.#state === 'cancelled' || this.#state === 'failed') return;
    this.#state = 'cancelled';
    this.#abort.abort();
    this.#clearLimit();
    void this.#recording?.then(
      opened => opened.cancel(),
      () => undefined,
    );
    this.#cleanup();
  }

  async #transcribe(): Promise<string> {
    const recording = this.#recording;
    if (recording === null) return '';
    const samples = await (await recording).stop();
    if (samples.length < MIN_SAMPLES) return '';
    return await this.#ports.engine.transcribe(samples, this.#abort.signal);
  }

  #fail(failure: BrowserRecognitionError): void {
    if (this.#state !== 'opening' && this.#state !== 'recording') return;
    this.#state = 'failed';
    this.#clearLimit();
    this.#cleanup();
    this.#options.onFailure(failure);
  }

  #clearLimit(): void {
    if (this.#limitTimer === null) return;
    this.#ports.clearTimeout(this.#limitTimer);
    this.#limitTimer = null;
  }

  #cleanup(): void {
    this.#unwatchHidden?.();
    this.#unwatchHidden = null;
  }
}
