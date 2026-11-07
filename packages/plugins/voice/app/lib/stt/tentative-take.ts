/**
 * AN EARLY FINISH: start working out the words of a take WHILE the pause that ends it is still being
 * confirmed, and either keep the work or throw it away cheaply.
 *
 * Live voice sends a message 1.5 s after the last word (a visible countdown, with Hold and Send now).
 * Without this, the on-device model starts only when that pause is confirmed, so its whole decode time
 * is added after the pause. With it, the caller calls `beginFinish()` the moment speech stops:
 *
 *   - if the speaker carries on, `discard()` — nothing was stopped, the recording is still open, and the
 *     answer is simply not used;
 *   - if the pause holds, `finish()` — when the audio added since is only quiet, the answer already in
 *     hand (or already being worked out) IS the answer, so the take ends with no decode of its own.
 *
 * WHAT IT NEVER DOES: stop the microphone, change what `finish()` returns for a take with new speech
 * in it, or send anything. The words a tentative take produces are the words `finish()` would have
 * produced for the same audio; `finish()` uses them only when the audio since the snapshot is quiet,
 * and decodes the whole take afresh otherwise.
 *
 * Offered by the whole-take engines (Parakeet 0.6B, Parakeet 110M and the other sherpa batch models,
 * Whisper). Not offered where it buys nothing or cannot be exact: Vosk streams while you speak (its
 * finish is already ~0.1 s), Browser voice has no model of ours, and Parakeet with near-live words on
 * re-reads a window of its own.
 */

/** One early finish. */
export interface TentativeTake {
  /**
   * The words of the audio recorded when the take began. Settles once. Rejects if the take was
   * discarded or the engine failed; a caller that only wants the cheap answer ignores the rejection.
   */
  readonly text: Promise<string>;
  /** More speech arrived: forget this attempt. Idempotent, instant, and leaves the recording open. */
  discard(): void;
}

/** The RMS under which the audio after a snapshot counts as quiet (`near-live.ts` clamps its floor to 0.004–0.015). */
export const QUIET_TAIL_RMS = 0.01;
/** A tail this short (20 ms, one frame) adds nothing a pause could not. */
export const IGNORED_TAIL_SAMPLES = 320;
/** Speech is looked for frame by frame, 20 ms at 16 kHz: a short word must not be averaged away by the silence around it. */
const TAIL_FRAME_SAMPLES = 320;

const rms = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
};

/** Whether ANY frame of `tail` holds speech. The whole-tail average would call a short burst plus a long pause "quiet". */
const hasSpeech = (tail: Float32Array): boolean => {
  for (let start = 0; start < tail.length; start += TAIL_FRAME_SAMPLES) {
    if (rms(tail.subarray(start, start + TAIL_FRAME_SAMPLES)) >= QUIET_TAIL_RMS) return true;
  }
  return false;
};

export interface TentativePorts {
  /** Everything recorded so far, while recording carries on (`AudioRecording.peek`). */
  peek(): Promise<Float32Array>;
  /** The engine's whole-take decode. */
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
}

interface Attempt {
  /** What the attempt learned, filled in as it runs. */
  readonly progress: { samples: number; discarded: boolean };
  readonly text: Promise<string>;
  readonly abort: AbortController;
}

/** The early-finish bookkeeping a whole-take session shares: one attempt at a time. */
export class TentativeTranscriber {
  readonly #ports: TentativePorts;
  readonly #outer: AbortSignal;
  #attempt: Attempt | null = null;

  /** `outer` is the session's own cancel: it aborts an attempt still in flight. */
  constructor(ports: TentativePorts, outer: AbortSignal) {
    this.#ports = ports;
    this.#outer = outer;
  }

  /** Begin an attempt on what has been recorded so far. A new attempt replaces (and discards) the last. */
  begin(): TentativeTake {
    this.#drop();
    const abort = new AbortController();
    const relay = (): void => abort.abort();
    this.#outer.addEventListener('abort', relay, { once: true });
    const progress = { samples: 0, discarded: false };
    const text = this.#ports
      .peek()
      .then(heard => {
        progress.samples = heard.length;
        return this.#ports.transcribe(heard, abort.signal);
      })
      .finally(() => this.#outer.removeEventListener('abort', relay));
    // A rejection nobody awaits is not an error: `discard()` and a failed engine both end here quietly.
    text.catch(() => undefined);
    const attempt: Attempt = { progress, text, abort };
    this.#attempt = attempt;
    return {
      text,
      discard: () => {
        progress.discarded = true;
        abort.abort();
        if (this.#attempt === attempt) this.#attempt = null;
      },
    };
  }

  /**
   * The answer to reuse for a take that ended with `final` samples — or `null` when ANY frame after the
   * attempt's snapshot has speech the attempt did not hear (decode it afresh), no attempt is live, the attempt
   * failed, or it was discarded, replaced, cleared or aborted while its answer was awaited.
   */
  async reuse(final: Float32Array): Promise<string | null> {
    const attempt = this.#attempt;
    if (attempt === null || attempt.progress.discarded) return null;
    let text: string;
    try {
      text = await attempt.text;
    } catch {
      return null;
    }
    const heard = attempt.progress.samples;
    if (final.length < heard) return null;
    const tail = final.subarray(heard);
    // Discard, a replacing begin, clear and the session abort all abort the attempt: a superseded answer is never reused.
    if (attempt.abort.signal.aborted) return null;
    return tail.length <= IGNORED_TAIL_SAMPLES || !hasSpeech(tail) ? text : null;
  }

  /** Drop any attempt: the session ended. */
  clear(): void {
    this.#drop();
  }

  #drop(): void {
    const attempt = this.#attempt;
    this.#attempt = null;
    if (attempt === null) return;
    attempt.progress.discarded = true;
    attempt.abort.abort();
  }
}
