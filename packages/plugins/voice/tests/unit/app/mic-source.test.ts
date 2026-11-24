import { afterEach, describe, expect, test } from 'bun:test';
import { UNIT_SAMPLES } from '../../../contract/index.ts';
import { browserMic, type MicEnvironment } from '../../../app/lib/stream/mic-source.ts';

interface Fake {
  readonly environment: MicEnvironment;
  readonly constraints: MediaStreamConstraints[];
  readonly trackStops: () => number;
  readonly closed: () => number;
  readonly gain: () => number;
  /** What the browser calls with each block of microphone samples. */
  process(block: Float32Array): void;
  readonly node: { onaudioprocess: ((event: unknown) => void) | null; disconnected: number };
}

function fake(sampleRate: number): Fake {
  const constraints: MediaStreamConstraints[] = [];
  let stops = 0;
  let closes = 0;
  const gain = { value: 1 };
  const node = { onaudioprocess: null as ((event: unknown) => void) | null, disconnected: 0 };
  const context = {
    sampleRate,
    destination: {},
    createMediaStreamSource: () => ({ connect: () => undefined }),
    createScriptProcessor: () => ({
      get onaudioprocess() {
        return node.onaudioprocess;
      },
      set onaudioprocess(value: ((event: unknown) => void) | null) {
        node.onaudioprocess = value;
      },
      connect: () => undefined,
      disconnect: () => {
        node.disconnected += 1;
      },
    }),
    createGain: () => ({ gain, connect: () => undefined }),
    close: async () => {
      closes += 1;
    },
  };
  return {
    environment: {
      getUserMedia: async wanted => {
        constraints.push(wanted);
        return {
          getTracks: () => [
            {
              stop: () => {
                stops += 1;
              },
            },
          ],
        } as unknown as MediaStream;
      },
      createContext: () => context as unknown as AudioContext,
    },
    constraints,
    trackStops: () => stops,
    closed: () => closes,
    gain: () => gain.value,
    process: block => node.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } }),
    node,
  };
}

describe('the browser microphone', () => {
  test('asks for echo cancellation, plays nothing back, and cuts the blocks into whole 640-sample units', async () => {
    const f = fake(16_000);
    const units: Int16Array[] = [];
    const mic = browserMic(f.environment);
    await mic.start(pcm => void units.push(pcm));
    expect(f.constraints[0]).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(f.gain()).toBe(0);
    f.process(new Float32Array(2048).fill(0.5));
    expect(units).toHaveLength(3); // 1920 of 2048; 128 wait for the next block
    f.process(new Float32Array(2048).fill(2)); // louder than full scale: clamped, never wrapped
    expect(units).toHaveLength(6);
    expect(units[0]?.[0]).toBe(16_384);
    expect(units[5]?.[0]).toBe(32_767);
    for (const unit of units) expect(unit).toHaveLength(UNIT_SAMPLES);
  });

  test('a 48 kHz context is resampled to 16 kHz before it is cut', async () => {
    const f = fake(48_000);
    const units: Int16Array[] = [];
    await browserMic(f.environment).start(pcm => void units.push(pcm));
    f.process(new Float32Array(6144).fill(0.25)); // 128 ms at 48 kHz = 2048 samples at 16 kHz
    expect(units).toHaveLength(3);
  });

  test('stop ends the processing, the tracks and the context, and may be called again', async () => {
    const f = fake(16_000);
    const mic = browserMic(f.environment);
    await mic.start(() => undefined);
    mic.stop();
    mic.stop();
    expect(f.node.onaudioprocess).toBeNull();
    expect(f.node.disconnected).toBe(1);
    expect(f.trackStops()).toBe(1);
    expect(f.closed()).toBe(1);
  });

  test('a refused microphone rejects start', async () => {
    const mic = browserMic({
      getUserMedia: async () => {
        throw new Error('denied');
      },
      createContext: () => {
        throw new Error('not reached');
      },
    });
    await expect(mic.start(() => undefined)).rejects.toThrow('denied');
  });
});

describe("the default environment is the page's own", () => {
  const real = { audioContext: (globalThis as { AudioContext?: unknown }).AudioContext };
  afterEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = real.audioContext;
    Reflect.deleteProperty(globalThis.navigator, 'mediaDevices');
  });

  test("getUserMedia is navigator.mediaDevices's and the context is opened at 16 kHz", async () => {
    const opened: number[] = [];
    const wanted: MediaStreamConstraints[] = [];
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          wanted.push(constraints);
          return { getTracks: () => [] } as unknown as MediaStream;
        },
      },
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      sampleRate = 16_000;
      destination = {};
      constructor(options: { sampleRate: number }) {
        opened.push(options.sampleRate);
      }
      createMediaStreamSource() {
        return { connect: () => undefined };
      }
      createScriptProcessor() {
        return { connect: () => undefined, disconnect: () => undefined, onaudioprocess: null };
      }
      createGain() {
        return { gain: { value: 1 }, connect: () => undefined };
      }
      async close() {}
    };
    const mic = browserMic();
    await mic.start(() => undefined);
    mic.stop();
    expect(opened).toEqual([16_000]);
    expect(wanted).toHaveLength(1);
  });
});
