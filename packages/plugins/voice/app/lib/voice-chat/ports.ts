/**
 * THE SEAMS OF VOICE CHAT. Domain code in this folder talks to the outside world only through these
 * interfaces, so each can be replaced by a fake in a test and by a different engine later (an on-device
 * neural voice, a cloud voice) without touching the reading logic.
 *
 * Slice 1 (Read aloud) defines the speaker. The listening ports of the Live loop (`TakePort`,
 * `SendPort`, …) join this file in their own slices.
 */

/** One voice the device can speak with. `local` is the browser's own `localService`: it stays on the device. */
export interface SpeakerVoice {
  /** The browser's `voiceURI`: stable enough to name the voice again. */
  readonly id: string;
  readonly name: string;
  /** BCP 47, as the browser reports it ("en-US"). */
  readonly lang: string;
  /** True when the voice is built into the device and speaks without sending text anywhere. */
  readonly local: boolean;
  /** The device's own pick for its language. */
  readonly isDefault: boolean;
}

/** What a speaker tells the one who asked it to speak. Every reading ends in exactly one of the last three. */
export type SpeakerEvent =
  /** This segment has just started to be said: the caption moves to it. */
  | { readonly type: 'segment'; readonly index: number }
  /** Everything was said. */
  | { readonly type: 'end' }
  /** `stop()` was called, or another reading replaced this one. */
  | { readonly type: 'stopped' }
  /** Speech was not possible or broke off. `unavailable`: this device cannot speak at all. */
  | { readonly type: 'error'; readonly reason: 'unavailable' | 'failed' };

export interface SpeakRequest {
  /** One entry per caption: the speaker may split an entry further for the engine, but reports it as one. */
  readonly segments: readonly string[];
  /** Speech rate, 0.8 – 2.0 (the speaker clamps). */
  readonly rate: number;
  /**
   * The voice to use, already vetted by the caller (who says in words if it sends text away). Absent or no
   * longer there: the speaker picks a voice that stays on the device for `language` itself — and when it
   * cannot, it refuses (`error`) rather than hand the text to the browser's unset default, which may be remote.
   */
  readonly voice?: SpeakerVoice | null;
  /** BCP 47 language of the text, for a speaker that has to choose its own voice. */
  readonly language?: string;
}

export interface SpeakerPort {
  /** False where the device has no speech at all, so a screen offers no Read aloud. */
  readonly supported: boolean;
  /** What the device can speak with right now. May be empty at first: browsers load voices late. */
  voices(): readonly SpeakerVoice[];
  /**
   * Make later speech allowed. iOS only lets speech start from a tap, so a caller that will speak later
   * calls this INSIDE the tap. Safe to call any number of times, and never audible.
   */
  unlock(): void;
  /** Say the request, replacing any reading already going (which hears `stopped`). */
  speak(request: SpeakRequest, onEvent: (event: SpeakerEvent) => void): void;
  /** Stop at once. The reading in progress hears `stopped`; with none, nothing happens. */
  stop(): void;
}
