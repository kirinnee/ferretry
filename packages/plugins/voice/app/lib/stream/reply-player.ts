import { STREAM_SAMPLE_RATE } from '../../../contract/index.ts';
import type { ReplyPlayer } from './voice-stream.ts';

/** The slice of the browser's audio this file touches, so a suite can stand one in. */
export interface PlayerContext {
  readonly currentTime: number;
  /** Seconds between a sample being scheduled and the person hearing it; absent where the browser does not say. */
  readonly outputLatency?: number;
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
  /** Sound scheduled and not yet wholly heard, in order, and the sound already heard of the line that came before them. */
  const queue: { readonly id: number; readonly at: number; readonly samples: number }[] = [];
  let done: { id: number; samples: number } | undefined;
  /** The moment the person hears now: what the context is at, less what the output still holds. */
  const heardNow = (): number => context.currentTime - (context.outputLatency ?? 0);
  const prune = (now: number): void => {
    for (
      let head = queue[0];
      head !== undefined && head.at + head.samples / STREAM_SAMPLE_RATE <= now;
      head = queue[0]
    ) {
      done = { id: head.id, samples: (done?.id === head.id ? done.samples : 0) + head.samples };
      queue.shift();
    }
  };
  void context.resume().catch(() => undefined);
  return {
    play(pcm, id) {
      if (pcm.length === 0) return;
      prune(heardNow());
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
      queue.push({ id, at, samples: samples.length });
      nextAt = at + samples.length / STREAM_SAMPLE_RATE;
    },
    position() {
      const now = heardNow();
      prune(now);
      const head = queue[0];
      if (head === undefined) return done;
      const into = Math.min(head.samples, Math.max(0, Math.round((now - head.at) * STREAM_SAMPLE_RATE)));
      return { id: head.id, samples: (done?.id === head.id ? done.samples : 0) + into };
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
      queue.length = 0;
      done = undefined;
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
