/**
 * A fake of the browser's `speechSynthesis`, driven by the test: nothing is ever played. Utterances queue
 * here; the test decides when one starts, ends or errors, exactly as the engine would.
 */

import type { BrowserVoiceLike, SynthLike, UtteranceLike } from '../../../app/lib/voice-chat/speech-synthesis.ts';

export class FakeUtterance implements UtteranceLike {
  rate = 1;
  volume = 1;
  lang = '';
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { readonly error?: string }) => void) | null = null;
  constructor(public text: string) {}
}

export class FakeSynth implements SynthLike {
  /** Every utterance handed to `speak`, in order, including ones later cancelled. */
  readonly spoken: FakeUtterance[] = [];
  /** What is queued right now: cleared by `cancel`. */
  queue: FakeUtterance[] = [];
  cancels = 0;
  /** Defaults to one local English voice: a speaker refuses to guess when the device lists none. */
  constructor(public voices: readonly BrowserVoiceLike[] = [voice('Test Voice', 'en-US', { isDefault: true })]) {}

  speak(utterance: UtteranceLike): void {
    const fake = utterance as FakeUtterance;
    this.spoken.push(fake);
    this.queue.push(fake);
  }

  cancel(): void {
    this.cancels += 1;
    const dropped = this.queue;
    this.queue = [];
    // A real engine reports the one that was playing as interrupted, after cancel returns.
    for (const utterance of dropped) utterance.onerror?.({ error: 'interrupted' });
  }

  getVoices(): readonly BrowserVoiceLike[] {
    return this.voices;
  }

  /** The utterance now at the head of the queue starts. */
  start(): FakeUtterance {
    const head = this.queue[0] as FakeUtterance;
    head.onstart?.();
    return head;
  }

  /** The head utterance finishes and leaves the queue. */
  finish(): FakeUtterance {
    const head = this.queue.shift() as FakeUtterance;
    head.onend?.();
    return head;
  }

  /** Start then finish the head, `times` times. */
  play(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      this.start();
      this.finish();
    }
  }
}

export const voice = (
  name: string,
  lang: string,
  options: { readonly local?: boolean; readonly isDefault?: boolean } = {},
): BrowserVoiceLike => ({
  voiceURI: `uri:${name}`,
  name,
  lang,
  localService: options.local ?? true,
  default: options.isDefault ?? false,
});
