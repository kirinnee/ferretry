/**
 * The pure rules of voice mode on the phone's own engine (the fallback): when a pause ends an utterance, when a lost
 * machine stream hands the loop to the phone, and what each sentence says. No clock, no browser, no IO.
 *
 * WHY THE PHONE DECIDES THE PAUSE. On the machine, the machine hears the pause and sends. On the phone nothing else is
 * listening, so the phone watches its own microphone level: it has heard speech, then stays quiet for
 * {@link PAUSE_MS}, and that ends the take. The length is the machine's own (`docs/voice.md` › The voice stream), so
 * the same person gets the same rhythm on either engine.
 */

/** How long a quiet stretch after speech ends an utterance. The machine's pause. */
export const PAUSE_MS = 1_500;

/** Above this RMS level (0..1) the microphone is heard to carry speech: twice the dictation meter's no-signal floor. */
export const SPEECH_LEVEL = 0.016;

/** Close codes that mean the person or the owner said no, not that the machine failed: the phone must not route round them. */
const REFUSED_CODES: ReadonlySet<number> = new Set([4401, 4403]);

/**
 * Whether a voice stream that ended should hand the loop to the phone. A normal end (the person pressed End) does not,
 * and neither does a refusal of permission (4401: voice narrowed for this device, 4403: the fleet permission is missing):
 * the phone would be doing what the owner just said this device may not. Everything else is a machine that could not
 * serve voice mode, which is exactly what the fallback is for.
 */
export function shouldFallBack(ended: { readonly code: number | undefined }): boolean {
  if (ended.code === 1000) return false;
  return ended.code === undefined || !REFUSED_CODES.has(ended.code);
}

/** The sentence a lost machine leaves in the panel's banner. `sentence` is the machine's own, when it said why. */
export function lostBanner(machine: string, code: number | undefined, sentence: string | undefined): string {
  if (sentence !== undefined && sentence !== '')
    return `${sentence} Voice mode carries on with this phone's own speech.`;
  if (code === 4408)
    return `${machine} stopped hearing this phone, so voice mode carries on with this phone's own speech.`;
  if (code === 4429)
    return `${machine} is already serving voice chats, so voice mode carries on with this phone's own speech.`;
  if (code === 4450) return `${machine} could not keep up, so voice mode carries on with this phone's own speech.`;
  return `Lost ${machine}, so voice mode carries on with this phone's own speech.`;
}

/** The banner when the machine could not be reached at all on press. */
export const unreachableBanner = (machine: string): string =>
  `${machine} cannot be reached, so voice mode runs on this phone's own speech.`;

/** The banner when the person chose to keep audio on this phone. */
export const keptOnPhoneBanner = 'You chose to keep audio on this phone, so voice mode runs on its own speech.';

/**
 * Hears the end of an utterance in a stream of microphone levels. Feed it each reading with its time; it answers `true`
 * once, at the first reading where speech was heard and {@link PAUSE_MS} of quiet has followed, then starts over. Quiet
 * before any speech is not a pause (the person has not started), and speech again cancels a pause in progress.
 */
export class PauseWatcher {
  readonly #pauseMs: number;
  readonly #speechLevel: number;
  #heard = false;
  #quietSince: number | null = null;

  constructor(pauseMs: number = PAUSE_MS, speechLevel: number = SPEECH_LEVEL) {
    this.#pauseMs = pauseMs;
    this.#speechLevel = speechLevel;
  }

  /** Whether speech has been heard in this take. */
  get heardSpeech(): boolean {
    return this.#heard;
  }

  feed(level: number, now: number): boolean {
    if (Number.isFinite(level) && level > this.#speechLevel) {
      this.#heard = true;
      this.#quietSince = null;
      return false;
    }
    if (!this.#heard) return false;
    this.#quietSince ??= now;
    if (now - this.#quietSince < this.#pauseMs) return false;
    this.reset();
    return true;
  }

  reset(): void {
    this.#heard = false;
    this.#quietSince = null;
  }
}
