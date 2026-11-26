import { describe, expect, test } from 'bun:test';
import { createReplyPlayer, PLAYBACK_LEAD_S, type PlayerContext } from '../../../app/lib/stream/reply-player.ts';

function fakeContext() {
  const started: { at: number; seconds: number; level: number }[] = [];
  const stopped: number[] = [];
  const state = { time: 10, state: 'suspended', resumes: 0, closes: 0, stopFails: false };
  const context: PlayerContext = {
    get currentTime() {
      return state.time;
    },
    get state() {
      return state.state;
    },
    destination: {},
    resume: async () => {
      state.resumes += 1;
      state.state = 'running';
    },
    close: async () => {
      state.closes += 1;
    },
    createBuffer: (_channels, length, rate) => {
      let first = 0;
      return {
        duration: length / rate,
        copyToChannel: source => {
          first = source[0] ?? 0;
        },
        get level() {
          return first;
        },
      } as ReturnType<PlayerContext['createBuffer']>;
    },
    createBufferSource: () => {
      const source = {
        buffer: undefined as unknown,
        connect: () => undefined,
        onended: null as (() => void) | null,
        start(at: number) {
          const buffer = source.buffer as { duration: number; level: number };
          started.push({ at, seconds: buffer.duration, level: buffer.level });
        },
        stop() {
          if (state.stopFails) throw new Error('already ended');
          stopped.push(started.length);
        },
      };
      return source;
    },
  };
  return { context, started, stopped, state };
}

describe('the reply player', () => {
  test('is unlocked at once, and schedules each piece to start where the last one ends, so speech has no gap', () => {
    const { context, started, state } = fakeContext();
    const player = createReplyPlayer(context);
    expect(state.resumes).toBe(1);
    player.play(new Int16Array(3_200).fill(16_384), 0);
    player.play(new Int16Array(3_200), 0);
    player.play(new Int16Array(1_600), 0);
    expect(started.map(part => part.seconds)).toEqual([0.2, 0.2, 0.1]);
    expect(started[0]?.at).toBeCloseTo(10 + PLAYBACK_LEAD_S, 5);
    expect(started[1]?.at).toBeCloseTo(10 + PLAYBACK_LEAD_S + 0.2, 5);
    expect(started[2]?.at).toBeCloseTo(10 + PLAYBACK_LEAD_S + 0.4, 5);
    expect(started[0]?.level).toBeCloseTo(0.5, 3);
    expect(player.remainingMs()).toBeCloseTo((PLAYBACK_LEAD_S + 0.5) * 1000, 3);
  });

  test('a unit that arrives late starts when it arrives, and the gap is the machine’s, not invented here', () => {
    const { context, started, state } = fakeContext();
    const player = createReplyPlayer(context);
    player.play(new Int16Array(3_200), 0);
    state.time = 20;
    player.play(new Int16Array(3_200), 0);
    expect(started[1]?.at).toBeCloseTo(20 + PLAYBACK_LEAD_S, 5);
    state.time = 40;
    expect(player.remainingMs()).toBe(0);
  });

  test('an empty piece is nothing, and a suspended context is woken by the next piece', () => {
    const { context, started, state } = fakeContext();
    const player = createReplyPlayer(context);
    player.play(new Int16Array(0), 0);
    expect(started).toHaveLength(0);
    state.state = 'suspended';
    player.play(new Int16Array(10), 0);
    expect(state.resumes).toBe(2);
  });

  test('stop silences everything queued and starts the schedule afresh; stopping what already ended is fine', () => {
    const { context, started, stopped, state } = fakeContext();
    const player = createReplyPlayer(context);
    player.play(new Int16Array(3_200), 0);
    player.play(new Int16Array(3_200), 0);
    player.stop();
    expect(stopped).toHaveLength(2);
    expect(player.remainingMs()).toBeGreaterThan(-1);
    player.play(new Int16Array(3_200), 0);
    expect(started.at(-1)?.at).toBeCloseTo(10 + PLAYBACK_LEAD_S, 5);
    state.stopFails = true;
    player.stop();
  });

  test('a piece that has ended is forgotten, and close stops and closes the context', () => {
    const { context, state } = fakeContext();
    const player = createReplyPlayer(context);
    player.play(new Int16Array(3_200), 0);
    player.close();
    expect(state.closes).toBe(1);
  });

  test('V2: it says where the person’s ears are: the line sounding and how much of it was heard, every line before it whole', () => {
    const { context, state } = fakeContext();
    const player = createReplyPlayer(context);
    expect(player.position()).toBeUndefined();
    // Line 0 is two 0.2 s units (10.15–10.55), line 1 one (10.55–10.75).
    player.play(new Int16Array(3_200), 0);
    player.play(new Int16Array(3_200), 0);
    player.play(new Int16Array(3_200), 1);
    state.time = 10;
    expect(player.position()).toEqual({ id: 0, samples: 0 });
    state.time = 10.45;
    expect(player.position()).toEqual({ id: 0, samples: 4_800 });
    state.time = 10.6;
    expect(player.position()).toEqual({ id: 1, samples: 800 });
    // Everything played: the newest line, heard whole. A cut now is "all of it", not "nothing".
    state.time = 12;
    expect(player.position()).toEqual({ id: 1, samples: 3_200 });
    player.stop();
    expect(player.position()).toBeUndefined();
  });

  test('V2: the sound the output still holds is not counted as heard', () => {
    const { context, state } = fakeContext();
    (context as { outputLatency?: number }).outputLatency = 0.1;
    const player = createReplyPlayer(context);
    player.play(new Int16Array(3_200), 4);
    state.time = 10.35; // started 10.15: 0.2 s in, less the 0.1 s the output still holds
    expect(player.position()).toEqual({ id: 4, samples: 1_600 });
    state.time = 10.45;
    expect(player.position()).toEqual({ id: 4, samples: 3_200 });
  });

  test('without a context of its own it uses the browser’s', () => {
    const real = (globalThis as { AudioContext?: unknown }).AudioContext;
    const { context } = fakeContext();
    (globalThis as { AudioContext?: unknown }).AudioContext = function () {
      return context;
    };
    try {
      const player = createReplyPlayer();
      player.play(new Int16Array(10), 0);
      expect(player.remainingMs()).toBeGreaterThan(0);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = real;
    }
  });

  test('a context that refuses to resume does not break playing', async () => {
    const { context } = fakeContext();
    context.resume = async () => {
      throw new Error('not allowed');
    };
    const player = createReplyPlayer(context);
    expect(() => player.play(new Int16Array(10), 0)).not.toThrow();
    await Promise.resolve();
  });
});
