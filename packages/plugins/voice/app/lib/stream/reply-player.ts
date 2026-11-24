import { STREAM_SAMPLE_RATE } from '../../../contract/index.ts';
import type { ReplyPlayer } from './voice-stream.ts';

/** The slice of the browser's audio this file touches, so a suite can stand one in. */
export interface PlayerContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): {
    copyToChannel(source: Float32Array, channel: number): void;
    readonly duration: number;
  };
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): void;
    start(when: number): void;
    stop(): void;
    onended: (() => void) | null;
  };
}

/** Sound is scheduled this far ahead of "now" at the start of a line, so the next unit lands before the last one ends. */
export const PLAYBACK_LEAD_S = 0.15;

/**
 * Plays the machine's reply sound as it arrives: each 200 ms of audio is scheduled to start exactly where the last one
 * ended, so the speech is gapless whatever the carrier's jitter, and a unit that arrives late leaves the gap the machine
 * itself left. It must be created INSIDE the tap that starts voice mode: a browser (iOS above all) lets sound start only
 * from a gesture, and one context unlocked there lasts the whole chat.
 */
export function createReplyPlayer(context: PlayerContext = browserContext()): ReplyPlayer {
  let nextAt = 0;
  const playing = new Set<{ stop(): void }>();
  void context.resume().catch(() => undefined);
  return {
    play(pcm) {
      if (pcm.length === 0) return;
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const samples = new Float32Array(pcm.length);
      for (let index = 0; index < pcm.length; index += 1) samples[index] = (pcm[index] ?? 0) / 32768;
      const buffer = context.createBuffer(1, samples.length, STREAM_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime + PLAYBACK_LEAD_S, nextAt);
      source.onended = () => playing.delete(source);
      playing.add(source);
      source.start(at);
      nextAt = at + samples.length / STREAM_SAMPLE_RATE;
    },
    stop() {
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already ended: nothing left to stop.
        }
      }
      playing.clear();
      nextAt = 0;
    },
    remainingMs: () => Math.max(0, nextAt - context.currentTime) * 1000,
    close() {
      this.stop();
      void context.close().catch(() => undefined);
    },
  };
}

function browserContext(): PlayerContext {
  return new AudioContext() as unknown as PlayerContext;
}
