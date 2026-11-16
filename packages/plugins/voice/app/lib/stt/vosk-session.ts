/**
 * One on-device dictation with Vosk: open the microphone, STREAM the recording into the Vosk worker as
 * it is made, and show its words while the person speaks. Audio never leaves this device: it goes from
 * the microphone to this page's memory to the worker, and only text comes back.
 *
 * It speaks the same contract as the browser-speech and Parakeet sessions — `start`, `finish`,
 * `cancel`, and the same callbacks — so `hooks/use-dictation.ts` drives it with one state machine.
 *
 * TRUE STREAMING, ALWAYS. Vosk is a streaming recognizer, so there is no "Live words" opt-in to honour:
 * every ~{@link PUMP_MS} ms the session reads what has been recorded (`AudioRecording.peek`) and feeds
 * the worker only the samples it has not fed yet. The worker answers with the words so far — committed
 * at each endpoint, interim after it — which reach `onLive`. Stop feeds the last stretch and asks for
 * the final text, which is little work because everything before it was decoded while it was spoken.
 *
 * One read at a time: the next is scheduled only after the previous one has been fed, so a slow device
 * reads less often rather than piling up. A failure of the engine mid-dictation (the model would not
 * load) ends the dictation at once rather than at Stop.
 */

import type { AudioCapturePort, AudioRecording } from './audio-capture.ts';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  browserRecognitionErrorFrom,
} from './browser-recognition.ts';
import type { SessionTimings } from './dictation-timeline.ts';
import { MIN_SPEECH_SAMPLES } from './near-live.ts';
import type { OnDeviceSessionOptions } from './on-device-voice.ts';
import { type VoskEngine, VoskEngineError, type VoskStream } from './vosk-engine.ts';
import { VOSK_VERSION_LABEL } from './vosk-model.ts';
import { VOSK_SAMPLE_RATE } from './vosk-worker-core.ts';

const MAX_DICTATION_MS = 120_000;
const BYTES_PER_SAMPLE = 4;
/** How often the recording is read and the new audio fed to the worker while the person speaks. */
export const PUMP_MS = 400;

export interface VoskSessionPorts {
  readonly capture: AudioCapturePort;
  readonly engine: Pick<VoskEngine, 'preload' | 'open'> & Partial<Pick<VoskEngine, 'consumeLoadMs'>>;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds on a monotonic clock. */
  now(): number;
}

type State = 'opening' | 'recording' | 'finishing' | 'finished' | 'failed' | 'cancelled';

/** Engine failures → the dictation panel's vocabulary. */
export const voskFailure = (error: unknown): BrowserRecognitionError => {
  if (error instanceof VoskEngineError) {
    if (error.code === 'cancelled') return new BrowserRecognitionError('aborted', error.message);
    if (error.code === 'not-installed') return new BrowserRecognitionError('model-not-installed', error.message);
    return new BrowserRecognitionError('recognition-failed', error.message);
  }
  return browserRecognitionErrorFrom(error);
};

export class VoskRecognitionSession implements BrowserRecognitionSessionLike {
  readonly #ports: VoskSessionPorts;
  readonly #options: OnDeviceSessionOptions;
  readonly #abort = new AbortController();
  #state: State = 'opening';
  #recording: Promise<AudioRecording> | null = null;
  #stream: VoskStream | null = null;
  /** How many samples of the take the worker has been fed. */
  #fed = 0;
  #pumpTimer: unknown = null;
  #limitTimer: unknown = null;
  #unwatchHidden: (() => void) | null = null;
  #finishing: Promise<string> | null = null;
  #timings: SessionTimings | undefined;

  constructor(ports: VoskSessionPorts, options: OnDeviceSessionOptions) {
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
          this.#stream = this.#ports.engine.open({
            onHeard: heard => {
              if (this.#state === 'recording') this.#options.onLive?.({ ...heard, paused: false });
            },
            onFailure: error => this.#fail(voskFailure(error)),
          });
        } catch (error) {
          this.#fail(voskFailure(error));
          return;
        }
        this.#schedulePump(opened);
      },
      (error: unknown) => this.#fail(voskFailure(error)),
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
        const failure = voskFailure(error);
        if (this.#state === 'finishing') {
          this.#state = failure.code === 'aborted' ? 'cancelled' : 'failed';
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
    this.#abort.abort();
    this.#options.onMonitor?.(null);
    this.#stream?.cancel();
    this.#clearTimers();
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
    const preparedAt = now();
    const samples = await opened.stop();
    const prepareMs = now() - preparedAt;
    const stream = this.#stream;
    const measured = (transcribeMs: number): void => {
      const loadMs = this.#ports.engine.consumeLoadMs?.();
      this.#timings = {
        audioMs: (samples.length / VOSK_SAMPLE_RATE) * 1000,
        audioBytes: samples.length * BYTES_PER_SAMPLE,
        prepareMs,
        transcribeMs,
        model: VOSK_VERSION_LABEL,
        ...(loadMs === undefined ? {} : { loadMs }),
      };
    };
    if (stream === null || samples.length < MIN_SPEECH_SAMPLES) {
      stream?.cancel();
      measured(0);
      return '';
    }
    const transcribingAt = now();
    // The last stretch: everything the reads while recording did not reach.
    if (samples.length > this.#fed) stream.feed(samples.slice(this.#fed));
    this.#fed = samples.length;
    try {
      return await stream.finish(this.#abort.signal);
    } finally {
      measured(now() - transcribingAt);
    }
  }

  #schedulePump(recording: AudioRecording): void {
    this.#pumpTimer = this.#ports.setTimeout(() => {
      this.#pumpTimer = null;
      void this.#pump(recording);
    }, PUMP_MS);
  }

  /** Feed the worker what was recorded since the last read, then schedule the next read. */
  async #pump(recording: AudioRecording): Promise<void> {
    if (this.#state !== 'recording') return;
    let samples: Float32Array;
    try {
      samples = await recording.peek();
    } catch {
      // A read that fails costs live words, not the dictation: Stop decodes the whole take.
      return;
    }
    // Stop or cancel came while reading: Stop feeds from where the last read left off.
    if (this.#state !== 'recording') return;
    if (samples.length > this.#fed) {
      this.#stream?.feed(samples.slice(this.#fed));
      this.#fed = samples.length;
    }
    this.#schedulePump(recording);
  }

  #fail(failure: BrowserRecognitionError): void {
    if (this.#state !== 'opening' && this.#state !== 'recording') return;
    this.#state = 'failed';
    this.#clearTimers();
    this.#options.onMonitor?.(null);
    this.#stream?.cancel();
    void this.#recording?.then(
      opened => opened.cancel(),
      () => undefined,
    );
    this.#cleanup();
    this.#options.onFailure(failure);
  }

  #clearTimers(): void {
    if (this.#limitTimer !== null) this.#ports.clearTimeout(this.#limitTimer);
    this.#limitTimer = null;
    if (this.#pumpTimer !== null) this.#ports.clearTimeout(this.#pumpTimer);
    this.#pumpTimer = null;
  }

  #cleanup(): void {
    this.#unwatchHidden?.();
    this.#unwatchHidden = null;
  }
}
