/**
 * Proves, through the REAL runner, the REAL take adapter, the REAL Parakeet session and the REAL browser
 * capture (only the browser's media APIs and the model are fakes), the two promises a stop makes:
 *
 *   - THE MICROPHONE CLOSES AT ONCE. Hold / typing / a hidden tab while the words are still being decoded
 *     stops the capture's own TRACKS right away — not when a slow (or stuck) model answers.
 *   - NOTHING SAID IS LOST. A stop in the middle of a spoken sentence (before the endpointer's pause) still
 *     works the sentence out and puts it in the message box; it lands On hold / Paused and sends nothing.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type AudioCaptureGlobalLike, browserAudioCapture } from '../../../src/lib/stt/audio-capture.ts';
import { ParakeetRecognitionSession } from '../../../src/lib/stt/parakeet-session.ts';
import { LiveRunner } from '../../../src/lib/voice-chat/live-runner.ts';
import { liveTakePort } from '../../../src/lib/voice-chat/live-take.ts';
import { type FakeLive, fakeLive } from '../../support/live-ports.ts';

/** The capture decodes blobs (`Blob.arrayBuffer`), which is not a microtask: let real timers run too. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    for (let micro = 0; micro < 20; micro += 1) await Promise.resolve();
  }
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

/** The browser's media APIs, with the microphone's tracks observable. */
const media = () => {
  const tracks = { live: 0, stopped: 0 };
  const recorders: { stops: number }[] = [];
  class Recorder {
    mimeType = 'audio/webm';
    ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly seen = { stops: 0 };
    constructor(_stream: unknown) {
      recorders.push(this.seen);
    }
    start(): void {}
    stop(): void {
      this.seen.stops += 1;
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
      this.onstop?.();
    }
    requestData(): void {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
    }
  }
  class Offline {
    async decodeAudioData() {
      const loud = new Float32Array(16_000).fill(0.2);
      return { numberOfChannels: 1, length: loud.length, getChannelData: () => loud };
    }
  }
  const global: AudioCaptureGlobalLike = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          tracks.live += 1;
          return {
            getTracks: () => [
              {
                stop: () => {
                  tracks.live -= 1;
                  tracks.stopped += 1;
                },
              },
            ],
          };
        },
      },
    },
    MediaRecorder: Recorder,
    OfflineAudioContext: Offline,
  };
  return { global, tracks, recorders };
};

/** A runner over fake ports, except the take: the real adapter over a real Parakeet session over real capture. */
const realRig = (fake: FakeLive) => {
  const world = media();
  const decode = deferred<string>();
  const decodes: AbortSignal[] = [];
  const take = liveTakePort({
    createSession: callbacks =>
      new ParakeetRecognitionSession(
        {
          capture: browserAudioCapture(world.global),
          engine: {
            preload: () => undefined,
            transcribe: async (_samples, signal) => {
              if (signal !== undefined) decodes.push(signal);
              return await decode.promise;
            },
          },
          watchHidden: () => () => undefined,
          setTimeout: () => 0,
          clearTimeout: () => undefined,
          now: () => fake.ports.clock.now(),
        },
        callbacks,
      ),
    clean: async text => ({ text, kept: 'raw' }),
  });
  const runner = new LiveRunner({ ...fake.ports, take }, { canSend: true });
  return { ...world, decode, decodes, runner };
};

const listening = async (fake: FakeLive) => {
  const rig = realRig(fake);
  rig.runner.start();
  await settle();
  should(rig.runner.state.phase).equal('listening');
  should(rig.tracks.live).equal(1);
  return rig;
};

describe('a stop while the on-device model is still decoding', () => {
  const STOPS: readonly (readonly [
    string,
    (fake: FakeLive, rig: ReturnType<typeof realRig>) => void,
    'hold' | 'paused',
  ])[] = [
    ['Hold', (_f, rig) => rig.runner.hold(), 'hold'],
    ['typing', (_f, rig) => rig.runner.typing(), 'hold'],
    ['a hidden tab', f => f.setVisible(false), 'paused'],
  ];

  for (const [name, stop, landing] of STOPS) {
    it(`${name} closes the capture's tracks at once, before the model answers, and the words still arrive and land on ${landing}`, async () => {
      const fake = fakeLive();
      const rig = await listening(fake);
      // A whole sentence, then the pause that starts the early finish (the model is decoding, slowly).
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      await settle();
      should(rig.runner.state.phase).equal('sending');
      should(rig.decodes.length).equal(1);
      should(rig.tracks.live).equal(1);

      stop(fake, rig);
      await settle();

      // The decode has NOT answered, yet the person's microphone is already closed.
      should(rig.tracks.live).equal(0);
      should(rig.tracks.stopped).equal(1);
      should(rig.recorders[0]?.stops).equal(1);
      should(rig.decodes[0]?.aborted).be.false();
      should(rig.runner.state.park).not.equal(null);

      // A stuck model is a model, not a microphone: nothing sends, nothing listens.
      fake.advance(60_000);
      await settle();
      should(fake.sends.length).equal(0);

      rig.decode.resolve('saved words');
      await settle();
      should(rig.runner.state.phase).equal(landing);
      should(fake.shown.at(-1)).equal('saved words');
      should(fake.sends.length).equal(0);
      should(rig.tracks.live).equal(0);
      rig.runner.dispose();
    });
  }
});

describe('a stop in the middle of a spoken sentence', () => {
  const STOPS: readonly (readonly [
    string,
    (fake: FakeLive, rig: ReturnType<typeof realRig>) => void,
    'hold' | 'paused',
  ])[] = [
    ['Hold', (_f, rig) => rig.runner.hold(), 'hold'],
    ['typing', (_f, rig) => rig.runner.typing(), 'hold'],
    ['a hidden tab', f => f.setVisible(false), 'paused'],
  ];

  for (const [name, stop, landing] of STOPS) {
    it(`${name} before the pause keeps the whole utterance: it is transcribed into the message box and lands on ${landing}`, async () => {
      const fake = fakeLive();
      const rig = await listening(fake);
      fake.hear(0.1, 600);
      await settle();
      should(rig.runner.state.phase).equal('hearing');
      should(rig.decodes.length).equal(0);

      stop(fake, rig);
      await settle();

      // The sentence was handed to the model (it was NOT thrown away) and the microphone is already shut.
      should(rig.decodes.length).equal(1);
      should(rig.decodes[0]?.aborted).be.false();
      should(rig.tracks.live).equal(0);
      should(rig.runner.state.countdown).equal(null);
      should(fake.shown).deepEqual([]);

      // Silence and more speech afterwards change nothing; no countdown, no send.
      fake.hear(0.001, 3_000);
      fake.hear(0.1, 600);
      fake.hear(0.001, 3_000);
      fake.advance(10_000);
      await settle();
      should(fake.sends.length).equal(0);

      rig.decode.resolve('the whole sentence');
      await settle();
      should(rig.runner.state.phase).equal(landing);
      should(fake.shown.at(-1)).equal('the whole sentence');
      should(fake.sends.length).equal(0);
      should(rig.tracks.live).equal(0);
      rig.runner.dispose();
    });
  }
});
