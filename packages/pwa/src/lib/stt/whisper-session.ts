/**
 * One Whisper dictation: open the microphone, record, then transcribe the whole take in the Whisper
 * worker on Stop. Audio never leaves this device: the recording goes from the microphone to this
 * page's memory to the worker, and the only thing that comes back is text.
 *
 * It speaks the same contract as every other session (`browser-recognition.ts`, `parakeet-session.ts`)
 * — `start`, `finish`, `cancel`, and the same callbacks — so `hooks/use-dictation.ts` and Settings'
 * Try it drive it with the state machine they already have. Whisper has no word times here and is not
 * re-run while recording, so there are no live words: `liveWords` and `onLive` are accepted and never
 * used, and the words appear when Stop transcribes the take.
 *
 * `timings().model` names the model AND the backend that ran it ("Whisper tiny.en q8 · 2575352 ·
 * WebGPU"), which is how Settings and the dictation timing say whether WebGPU or WebAssembly ran.
 */

import { type AudioCapturePort, type AudioRecording, PARAKEET_SAMPLE_RATE } from './audio-capture.ts';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  browserRecognitionErrorFrom,
} from './browser-recognition.ts';
import type { SessionTimings } from './dictation-timeline.ts';
import { MIN_SPEECH_SAMPLES } from './near-live.ts';
import type { OnDeviceSessionOptions } from './on-device-voice.ts';
import { type WhisperEngine, WhisperEngineError } from './whisper-engine.ts';
import type { WhisperBackend } from './whisper-worker-core.ts';

const MAX_DICTATION_MS = 120_000;
const BYTES_PER_SAMPLE = 4;

/** How the backend is said where a person reads it. */
export const WHISPER_BACKEND_LABEL: Readonly<Record<WhisperBackend, string>> = {
  webgpu: 'WebGPU',
  wasm: 'WebAssembly',
};

export interface WhisperSessionPorts {
  readonly capture: AudioCapturePort;
  readonly engine: Pick<WhisperEngine, 'preload' | 'transcribe'> & Partial<Pick<WhisperEngine, 'consumeLoadMs'>>;
  /** The installed model's version, which the timings name. */
  readonly versionLabel: string;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds on a monotonic clock. */
  now(): number;
}

type State = 'opening' | 'recording' | 'finishing' | 'finished' | 'failed' | 'cancelled';

/** Engine failures → the dictation panel's vocabulary. */
export const whisperFailure = (error: unknown): BrowserRecognitionError => {
  if (error instanceof WhisperEngineError) {
    if (error.code === 'cancelled') return new BrowserRecognitionError('aborted', error.message);
    if (error.code === 'not-installed') return new BrowserRecognitionError('model-not-installed', error.message);
    return new BrowserRecognitionError('recognition-failed', error.message);
  }
  return browserRecognitionErrorFrom(error);
};

export class WhisperRecognitionSession implements BrowserRecognitionSessionLike {
  readonly #ports: WhisperSessionPorts;
  readonly #options: OnDeviceSessionOptions;
  readonly #abort = new AbortController();
  #state: State = 'opening';
  #recording: Promise<AudioRecording> | null = null;
  #limitTimer: unknown = null;
  #unwatchHidden: (() => void) | null = null;
  #finishing: Promise<string> | null = null;
  #timings: SessionTimings | undefined;

  constructor(ports: WhisperSessionPorts, options: OnDeviceSessionOptions) {
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
        this.#options.onMonitor?.(opened.monitor);
        // Load while the person speaks. A failure here is reported by the transcribe that follows.
        try {
          this.#ports.engine.preload();
        } catch {
          // The same failure reaches `finish`, where the reader sees it.
        }
      },
      (error: unknown) => this.#fail(whisperFailure(error)),
    );
  }

  finish(): Promise<string> {
    if (this.#finishing !== null) return this.#finishing;
    if (this.#state === 'failed' || this.#state === 'cancelled')
      return Promise.reject(new BrowserRecognitionError('aborted', 'Dictation already ended.'));
    this.#state = 'finishing';
    this.#clearLimit();
    this.#options.onMonitor?.(null);
    this.#finishing = this.#transcribe().then(
      text => {
        if (this.#state !== 'finishing') throw new BrowserRecognitionError('aborted', 'Dictation was cancelled.');
        this.#state = 'finished';
        this.#cleanup();
        return text;
      },
      (error: unknown) => {
        // A take cancelled while it was transcribing ended as a cancel, whatever the engine says late.
        if (this.#state === 'cancelled') throw new BrowserRecognitionError('aborted', 'Dictation was cancelled.');
        const failure = whisperFailure(error);
        this.#state = failure.code === 'aborted' ? 'cancelled' : 'failed';
        this.#cleanup();
        throw failure;
      },
    );
    return this.#finishing;
  }

  /** What the last `finish` measured, with the model and the backend that ran it. */
  timings(): SessionTimings | undefined {
    return this.#timings;
  }

  cancel(): void {
    if (this.#state === 'finished' || this.#state === 'cancelled' || this.#state === 'failed') return;
    this.#state = 'cancelled';
    this.#abort.abort();
    this.#options.onMonitor?.(null);
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
    const { now, versionLabel } = this.#ports;
    const opened = await recording;
    const preparedAt = now();
    const samples = await opened.stop();
    const prepareMs = now() - preparedAt;
    // The take's buffer is transferred to the worker below, which empties it: read its size first.
    const audioMs = (samples.length / PARAKEET_SAMPLE_RATE) * 1000;
    const audioBytes = samples.length * BYTES_PER_SAMPLE;
    const measured = (transcribeMs: number, backend: WhisperBackend | null): void => {
      const loadMs = this.#ports.engine.consumeLoadMs?.();
      this.#timings = {
        audioMs,
        audioBytes,
        prepareMs,
        transcribeMs,
        model: backend === null ? versionLabel : `${versionLabel} · ${WHISPER_BACKEND_LABEL[backend]}`,
        ...(loadMs === undefined ? {} : { loadMs }),
      };
    };
    // Whisper invents words for silence; a take too short to hold speech is not sent to it.
    if (samples.length < MIN_SPEECH_SAMPLES) {
      measured(0, null);
      return '';
    }
    const transcribingAt = now();
    let backend: WhisperBackend | null = null;
    try {
      const heard = await this.#ports.engine.transcribe(samples, this.#abort.signal);
      backend = heard.backend;
      return heard.text;
    } finally {
      measured(now() - transcribingAt, backend);
    }
  }

  #fail(failure: BrowserRecognitionError): void {
    if (this.#state !== 'opening' && this.#state !== 'recording') return;
    this.#state = 'failed';
    this.#clearLimit();
    this.#options.onMonitor?.(null);
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
