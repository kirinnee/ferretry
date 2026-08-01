/**
 * Microphone capture: the imperative shell, with the audio graph behind a port.
 *
 * THE ONE INVARIANT THAT MATTERS. A microphone that outlives the utterance is
 * the fastest way to lose a reader's trust — the browser's recording indicator
 * stays lit and there is nothing they can do about it. So `release()` is
 * idempotent, it is called from `stop()`, from `cancel()`, from the error path,
 * from the tab going hidden, and from the caller's unmount, and whichever fires
 * first wins; the rest are no-ops.
 *
 * AUDIO IS NEVER PERSISTED. Samples live in a JS array for the length of one
 * utterance and are dropped as soon as the transcript comes back. Nothing is
 * written to IndexedDB, CacheStorage, browser storage or a file, and no `Blob`
 * of recorded audio is ever handed to anything that could store one.
 *
 * PERMISSION IS REQUESTED FROM THE GESTURE. `openMicrophone` is called as the
 * first statement with no `await` above it, so the call happens inside the
 * pointerdown/keydown task and browsers treat it as user-initiated. Anything
 * that needs to happen first must happen in the caller, before it calls this.
 *
 * WHY THE GRAPH IS A PORT. kteam built the `AudioContext`, the AudioWorklet and
 * the ScriptProcessor fallback inline (`ui/src/lib/stt/audio-capture.ts:283-503`),
 * which put the accept/ceiling/flush rules — the part that actually had the
 * bugs — behind Web Audio globals no test can construct. Here `CaptureHost`
 * declares what capture needs from the browser and this module owns only the
 * rules, so every one of them is executed by a test with no device.
 */

import { CaptureError, captureErrorFrom } from './capture-error.ts';
import { concatFloat32, MAX_UTTERANCE_SECONDS, resample, TARGET_SAMPLE_RATE } from './pcm.ts';

/** A visual-only branch off the recorder's already-running audio graph. */
export interface CaptureAnalyserTap {
  readonly analyser: unknown;
  /** Disconnect this branch without touching the recorder or its tracks. */
  disconnect(): void;
}

/**
 * The live audio graph for ONE capture.
 *
 * Implemented against Web Audio by the composition root. Everything it exposes
 * is something capture genuinely needs; nothing about nodes leaks through.
 */
export interface CaptureGraph {
  /** The rate the samples arrive at, before resampling. */
  readonly inputSampleRate: number;
  /**
   * Ask the graph for its batched tail and resolve once it has been delivered.
   *
   * The batch is the whole reason this exists: a worklet holds up to ~256 ms of
   * unposted frames, and a timer that fired early would drop exactly the last
   * word of every utterance.
   */
  flush(): Promise<void>;
  /** A read-only analyser branch, or `null` once the graph is gone. */
  createAnalyser(): CaptureAnalyserTap | null;
  /** Stop every node and close the device. Idempotent; never throws. */
  release(): void;
}

export interface MicrophoneStream {
  /** Handed to consumers that want to analyse it. They must never stop its tracks. */
  readonly stream: unknown;
}

export interface CaptureHost {
  /**
   * `getUserMedia`. Must be reachable synchronously from the gesture, so
   * capture calls it before anything that awaits.
   */
  openMicrophone(): Promise<MicrophoneStream>;
  /**
   * Build the graph around an open microphone and start delivering samples to
   * `sink`. Each delivery is an independent buffer the sink may retain.
   */
  buildGraph(microphone: MicrophoneStream, sink: (samples: Float32Array) => void): Promise<CaptureGraph>;
  /** Notify when the tab goes to the background. Returns the unsubscribe. */
  watchHidden(onHidden: () => void): () => void;
}

export interface CaptureSession {
  /**
   * The exact device stream feeding this capture. Consumers may analyse it,
   * but must never stop its tracks; this session remains the sole owner.
   */
  readonly stream: unknown;
  /** Read-only analyser factory sharing this capture's active audio graph. */
  createAnalyser(): CaptureAnalyserTap | null;
  /** The rate the samples were captured at, before resampling. */
  readonly inputSampleRate: number;
  /** True until the first `stop()`, `cancel()` or failure. */
  readonly active: boolean;
  /**
   * Stop, release the device, and return the utterance as 16 kHz mono float.
   * Idempotent: a second call returns the same buffer.
   */
  stop(): Promise<Float32Array>;
  /** Throw the audio away and release the device. Never rejects. */
  cancel(): void;
}

/** Why a capture ended without the caller asking it to. */
export type CaptureAbortReason = 'hidden';

export interface StartCaptureOptions {
  /**
   * Called when the utterance hits `MAX_UTTERANCE_SECONDS` and capture stops
   * itself. The caller should treat it exactly like the reader letting go.
   */
  readonly onLimit?: () => void;
  /**
   * Called when the capture ends INVOLUNTARILY — today, only because the tab
   * went to the background and the microphone had to be closed.
   *
   * This exists because the alternative is a controller that still believes it
   * is recording: the button stays pressed-looking, a new utterance is refused,
   * and a later release hands the abandoned samples to an engine. The audio is
   * already discarded by the time this fires, so it is a notification, not a
   * decision — the caller's job is to return itself to idle.
   */
  readonly onAbort?: (reason: CaptureAbortReason) => void;
  /**
   * A copied view of every sample batch the recorder accepted, including the
   * final flush tail. This is the only PCM observation seam for live
   * transcription: consumers must segment it, never open a second stream or
   * stop the recorder-owned tracks. The callback is synchronous and its buffer
   * is independent, so retaining or mutating it cannot corrupt the finished
   * utterance.
   */
  readonly onSamples?: (samples: Float32Array, inputSampleRate: number) => void;
}

/**
 * The accumulator, the hard ceiling and the two closing flags.
 *
 * `accepting` is DELIBERATELY SEPARATE FROM `active`, and the reason is a whole
 * utterance's tail. The graph batches frames before posting, so at the instant
 * of release it is holding up to ~256 ms of unposted audio. Those arrive in the
 * flush that `stop()` asks for, which is AFTER the reader let go. Gating that
 * arrival on `active` would silently drop the end of every single utterance:
 * the last word, every time.
 *
 * So `active` answers "is the microphone open" and goes false immediately,
 * while `accepting` stays true across the flush window. `cancel()` clears both
 * at once, because a cancelled utterance wants no tail at all.
 */
class Utterance {
  #chunks: Float32Array[] = [];
  #captured = 0;
  #active = true;
  #accepting = true;
  #result: Float32Array | null = null;
  inputSampleRate = TARGET_SAMPLE_RATE;

  constructor(private readonly options: StartCaptureOptions) {}

  get active(): boolean {
    return this.#active;
  }

  get finished(): Float32Array | null {
    return this.#result;
  }

  /** The microphone is closed to the caller; the tail may still arrive. */
  closeMicrophone(): void {
    this.#active = false;
  }

  closeAcceptance(): void {
    this.#accepting = false;
  }

  #maxSamples(): number {
    return MAX_UTTERANCE_SECONDS * this.inputSampleRate;
  }

  accept(samples: Float32Array): void {
    // `accepting`, NOT `active` — see the class comment.
    if (!this.#accepting || samples.length === 0) return;
    const remaining = this.#maxSamples() - this.#captured;
    if (remaining <= 0) return;
    const slice = samples.length <= remaining ? samples : samples.slice(0, remaining);
    this.#chunks.push(slice);
    this.#captured += slice.length;
    try {
      // Copy AFTER enforcing the hard ceiling, and notify BEFORE onLimit asks
      // the controller to stop. That ordering lets a live segmenter see the
      // final accepted samples exactly once. Observer failures are isolated
      // from microphone ownership.
      this.options.onSamples?.(slice.slice(), this.inputSampleRate);
    } catch {
      // An observer must never strand the microphone.
    }
    if (this.#captured >= this.#maxSamples()) {
      // Close the device to the caller immediately, then tell them. Waiting for
      // the caller to react would leave the microphone open for another turn.
      // `accepting` stays true: the ceiling is already enforced above, and the
      // caller's `onLimit` handler runs the same flush as a manual release.
      this.#active = false;
      this.options.onLimit?.();
    }
  }

  /** Concatenate and resample once; later calls return the same buffer. */
  finish(): Float32Array {
    if (this.#result !== null) return this.#result;
    const raw = concatFloat32(this.#chunks);
    // Drop the references before resampling so the peak is one copy, not two.
    this.#chunks = [];
    this.#result = resample(raw, this.inputSampleRate, TARGET_SAMPLE_RATE);
    return this.#result;
  }

  /** Abandon everything held. The result becomes an empty buffer, for good. */
  abandon(): void {
    this.#active = false;
    this.#accepting = false;
    this.#chunks = [];
    this.#result = new Float32Array(0);
  }
}

/**
 * Open the microphone and return a session that owns it.
 *
 * Rejects with a `CaptureError` — the caller is expected to render its `code`,
 * and the device is already released by the time it does.
 */
export async function startCapture(host: CaptureHost, options: StartCaptureOptions = {}): Promise<CaptureSession> {
  // FIRST STATEMENT, NO AWAIT ABOVE IT: the permission prompt has to be
  // attributable to the gesture that called us.
  const microphonePromise = host.openMicrophone();

  const utterance = new Utterance(options);
  let graph: CaptureGraph | null = null;
  let unwatch: (() => void) | null = null;
  let released = false;
  /**
   * In-flight `stop()`, so concurrent or repeated calls share one flush rather
   * than each asking the graph to flush again.
   */
  let stopping: Promise<Float32Array> | null = null;

  const release = (): void => {
    if (released) return;
    released = true;
    utterance.closeMicrophone();
    utterance.closeAcceptance();
    unwatch?.();
    unwatch = null;
    graph?.release();
    graph = null;
  };

  let microphone: MicrophoneStream;
  try {
    microphone = await microphonePromise;
  } catch (error) {
    release();
    throw captureErrorFrom(error);
  }

  try {
    graph = await host.buildGraph(microphone, samples => utterance.accept(samples));
    utterance.inputSampleRate = graph.inputSampleRate > 0 ? graph.inputSampleRate : TARGET_SAMPLE_RATE;
    unwatch = host.watchHidden(() => {
      // Already ended — by a normal stop, a cancel, or an earlier hide. This is
      // not a second abort and must not be announced as one.
      if (released) return;
      // A backgrounded capture is ABANDONED, not paused. The samples are
      // dropped here rather than merely left unused, so that even a caller that
      // mishandles the notification cannot transcribe half an utterance
      // recorded before the reader switched away.
      utterance.abandon();
      stopping = null;
      release();
      options.onAbort?.('hidden');
    });
  } catch (error) {
    release();
    throw captureErrorFrom(error);
  }

  return {
    stream: microphone.stream,
    createAnalyser: () => (released ? null : (graph?.createAnalyser() ?? null)),
    get inputSampleRate() {
      return utterance.inputSampleRate;
    },
    get active() {
      return utterance.active;
    },
    async stop(): Promise<Float32Array> {
      const finished = utterance.finished;
      if (finished !== null) return finished;
      if (stopping !== null) return stopping;
      // The microphone is closed to the caller from this instant. Sample
      // ACCEPTANCE stays open a moment longer — see `Utterance`.
      utterance.closeMicrophone();
      const pending = graph;
      stopping = (async () => {
        try {
          await pending?.flush();
        } catch {
          // The graph is already gone; whatever it batched is unreachable.
        }
        utterance.closeAcceptance();
        release();
        return utterance.finish();
      })();
      return stopping;
    },
    cancel(): void {
      // A cancelled utterance wants no tail at all, so acceptance closes with
      // the microphone rather than after it.
      utterance.abandon();
      stopping = null;
      release();
    },
  };
}

/**
 * Does this browser expose a microphone API at all?
 *
 * `navigator.mediaDevices` is UNDEFINED — not merely restricted — in an
 * insecure context, which is the plain-HTTP case. The control is hidden rather
 * than disabled when this is false: a disabled button implies "not right now",
 * and this is "not on this URL, ever".
 */
export const hasMicrophoneApi = (nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined): boolean =>
  typeof nav?.mediaDevices?.getUserMedia === 'function';

/** The constraints capture asks for. Named so a host implementation shares them. */
export const CAPTURE_AUDIO_CONSTRAINTS = Object.freeze({
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

/**
 * The refusal a host must raise when the page has no microphone API at all.
 * Exported so a host does not have to reproduce the wording.
 */
export const noMicrophoneApiError = (): CaptureError =>
  new CaptureError('no-media-devices', 'This browser has no microphone API on this page.');
