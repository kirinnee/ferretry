/**
 * One on-device dictation with a STREAMING model: words appear while the person speaks, from the
 * model itself rather than from re-reading a window (compare `near-live.ts`).
 *
 * It speaks the same contract as every other session (`browser-recognition.ts`, `parakeet-session.ts`)
 * — `start`, `finish`, `cancel`, and the same callbacks — so `hooks/use-dictation.ts` drives it with
 * the one state machine. Audio never leaves this device: the recording goes from the microphone to this
 * page's memory to the speech worker, and only text comes back.
 *
 * While recording it reads the take about four times a second and pushes only the samples the stream
 * has not heard yet; every push is answered with the words so far, reported through `onLive` as
 * committed (settled phrases) and interim (the phrase still being heard). Stop pushes the rest, closes
 * the stream, and resolves with the whole text. Reads never overlap: the next is scheduled only after
 * the last one has been pushed.
 */

import type { AudioCapturePort, AudioRecording } from './audio-capture.ts';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  browserRecognitionErrorFrom,
} from './browser-recognition.ts';
import type { SessionTimings } from './dictation-timeline.ts';
import type { OnDeviceSessionOptions } from './on-device-voice.ts';
import type { StreamWords } from './sherpa-engine.ts';

const MAX_DICTATION_MS = 120_000;
const SAMPLE_RATE_HZ = 16_000;
const BYTES_PER_SAMPLE = 4;
/** How often the open take is read and pushed. */
export const STREAM_PUSH_MS = 250;

/** One take's stream in a streaming engine. */
export interface StreamingEngineStream {
  push(samples: Float32Array): void;
  close(): Promise<string>;
  drop(): void;
}

/** What a streaming session needs from its engine. */
export interface StreamingEngine {
  preload(): void;
  consumeLoadMs?(): number | undefined;
  openStream(callbacks: {
    onPartial(words: StreamWords): void;
    onFailure(error: unknown): void;
  }): StreamingEngineStream;
}

export interface StreamingSessionPorts {
  readonly capture: AudioCapturePort;
  readonly engine: StreamingEngine;
  /** What the timeline names the model, e.g. its version label. */
  readonly model: string;
  /** Engine failures → the dictation panel's vocabulary. */
  failure(error: unknown): BrowserRecognitionError;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds on a monotonic clock. */
  now(): number;
}

type State = 'opening' | 'recording' | 'finishing' | 'finished' | 'failed' | 'cancelled';

export class StreamingRecognitionSession implements BrowserRecognitionSessionLike {
  readonly #ports: StreamingSessionPorts;
  readonly #options: OnDeviceSessionOptions;
  #state: State = 'opening';
  #recording: Promise<AudioRecording> | null = null;
  #stream: StreamingEngineStream | null = null;
  /** Samples of the take the stream has heard. */
  #sent = 0;
  #pushing: Promise<void> = Promise.resolve();
  #pushTimer: unknown = null;
  #limitTimer: unknown = null;
  #unwatchHidden: (() => void) | null = null;
  #finishing: Promise<string> | null = null;
  #timings: SessionTimings | undefined;

  constructor(ports: StreamingSessionPorts, options: OnDeviceSessionOptions) {
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
        try {
          this.#ports.engine.preload();
          this.#stream = this.#ports.engine.openStream({
            onPartial: words => {
              if (this.#state === 'recording') this.#options.onLive?.({ ...words, paused: false });
            },
            onFailure: error => this.#fail(this.#ports.failure(error)),
          });
        } catch (error) {
          this.#fail(this.#ports.failure(error));
          return;
        }
        this.#schedulePush(opened);
      },
      (error: unknown) => this.#fail(browserRecognitionErrorFrom(error)),
    );
  }

  finish(): Promise<string> {
    if (this.#finishing !== null) return this.#finishing;
    if (this.#state === 'failed' || this.#state === 'cancelled')
      return Promise.reject(new BrowserRecognitionError('aborted', 'Dictation already ended.'));
    this.#state = 'finishing';
    this.#clearTimers();
    this.#options.onMonitor?.(null);
    this.#finishing = this.#transcribe().then(
      text => {
        if (this.#state !== 'finishing') throw new BrowserRecognitionError('aborted', 'Dictation was cancelled.');
        this.#state = 'finished';
        this.#cleanup();
        return text;
      },
      (error: unknown) => {
        const failure = error instanceof BrowserRecognitionError ? error : this.#ports.failure(error);
        if (this.#state === 'finishing') {
          this.#state = failure.code === 'aborted' ? 'cancelled' : 'failed';
          this.#stream?.drop();
          this.#cleanup();
        }
        throw failure;
      },
    );
    return this.#finishing;
  }

  /** What the last `finish` measured. */
  timings(): SessionTimings | undefined {
    return this.#timings;
  }

  cancel(): void {
    if (this.#state === 'finished' || this.#state === 'cancelled' || this.#state === 'failed') return;
    this.#state = 'cancelled';
    this.#options.onMonitor?.(null);
    this.#clearTimers();
    this.#stream?.drop();
    void this.#recording?.then(
      opened => opened.cancel(),
      () => undefined,
    );
    this.#cleanup();
  }

  async #transcribe(): Promise<string> {
    const recording = this.#recording;
    if (recording === null) return '';
    const { now } = this.#ports;
    const opened = await recording;
    await this.#pushing;
    const preparedAt = now();
    const samples = await opened.stop();
    const prepareMs = now() - preparedAt;
    const stream = this.#stream;
    if (stream === null) return '';
    const closingAt = now();
    this.#pushNew(samples);
    const text = await stream.close();
    const loadMs = this.#ports.engine.consumeLoadMs?.();
    this.#timings = {
      audioMs: (samples.length / SAMPLE_RATE_HZ) * 1000,
      audioBytes: samples.length * BYTES_PER_SAMPLE,
      prepareMs,
      transcribeMs: now() - closingAt,
      model: this.#ports.model,
      ...(loadMs === undefined ? {} : { loadMs }),
    };
    return text;
  }

  /** Push what the stream has not heard yet. */
  #pushNew(samples: Float32Array): void {
    if (samples.length <= this.#sent) return;
    this.#stream?.push(samples.slice(this.#sent));
    this.#sent = samples.length;
  }

  #schedulePush(recording: AudioRecording): void {
    this.#pushTimer = this.#ports.setTimeout(() => {
      this.#pushTimer = null;
      if (this.#state !== 'recording') return;
      this.#pushing = recording.peek().then(
        samples => {
          if (this.#state !== 'recording') return;
          this.#pushNew(samples);
          this.#schedulePush(recording);
        },
        () => {
          // A read that failed loses nothing: the next read, or Stop, pushes the same samples.
          if (this.#state === 'recording') this.#schedulePush(recording);
        },
      );
    }, STREAM_PUSH_MS);
  }

  #fail(failure: BrowserRecognitionError): void {
    if (this.#state !== 'opening' && this.#state !== 'recording') return;
    this.#state = 'failed';
    this.#clearTimers();
    this.#stream?.drop();
    this.#options.onMonitor?.(null);
    void this.#recording?.then(
      opened => opened.cancel(),
      () => undefined,
    );
    this.#cleanup();
    this.#options.onFailure(failure);
  }

  #clearTimers(): void {
    if (this.#limitTimer !== null) this.#ports.clearTimeout(this.#limitTimer);
    if (this.#pushTimer !== null) this.#ports.clearTimeout(this.#pushTimer);
    this.#limitTimer = null;
    this.#pushTimer = null;
  }

  #cleanup(): void {
    this.#unwatchHidden?.();
    this.#unwatchHidden = null;
  }
}
