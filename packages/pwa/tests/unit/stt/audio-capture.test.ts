/**
 * Proves the microphone capture for the on-device engine: the mono mix, the capability check, and
 * the recorder lifecycle — start, stop (collect, release, decode at 16 kHz), cancel — over fake
 * browser APIs, including every path that must release the microphone.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AudioCaptureGlobalLike,
  browserAudioCapture,
  canCaptureAudio,
  type MediaRecorderLike,
  type MediaStreamLike,
  mixToMono,
  PARAKEET_SAMPLE_RATE,
} from '../../../src/lib/stt/audio-capture.ts';

const buffer = (channels: number[][]) => ({
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  getChannelData: (channel: number) => Float32Array.from(channels[channel] ?? []),
});

describe('mixToMono', () => {
  it('returns a single channel unchanged', () => {
    should(Array.from(mixToMono(buffer([[0.5, -0.25, 1]])))).eql([0.5, -0.25, 1]);
  });

  it('averages two channels', () => {
    should(
      Array.from(
        mixToMono(
          buffer([
            [1, 0.5, 0],
            [0, 0.5, -1],
          ]),
        ),
      ),
    ).eql([0.5, 0.5, -0.5]);
  });

  it('treats a short channel as silence past its end', () => {
    const mixed = mixToMono({
      numberOfChannels: 2,
      length: 2,
      getChannelData: channel => (channel === 0 ? new Float32Array([1, 1]) : new Float32Array([1])),
    });
    should(Array.from(mixed)).eql([1, 0.5]);
  });

  it('yields silence of the right length for no channels', () => {
    should(mixToMono({ numberOfChannels: 0, length: 3, getChannelData: () => new Float32Array() }).length).equal(3);
  });
});

class FakeStream implements MediaStreamLike {
  stopped = 0;
  readonly tracks = [{ stop: () => (this.stopped += 1) }, { stop: () => (this.stopped += 1) }];
  getTracks() {
    return this.tracks;
  }
}

class FakeRecorder implements MediaRecorderLike {
  static last: FakeRecorder | null = null;
  static throwOnConstruct: unknown = undefined;
  static throwOnStop: unknown = undefined;
  static emitOnStop: Blob[] | null = [];
  mimeType = 'audio/webm';
  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  started = 0;
  stops = 0;

  constructor(readonly stream: MediaStreamLike) {
    if (FakeRecorder.throwOnConstruct !== undefined) throw FakeRecorder.throwOnConstruct;
    FakeRecorder.last = this;
  }

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stops += 1;
    if (FakeRecorder.throwOnStop !== undefined) throw FakeRecorder.throwOnStop;
    for (const blob of FakeRecorder.emitOnStop ?? []) this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }
}

class FakeOffline {
  static args: [number, number, number][] = [];
  static decoded: ArrayBuffer[] = [];
  static channels: number[][] = [[0.5, 0.5]];

  constructor(channels: number, length: number, sampleRate: number) {
    FakeOffline.args.push([channels, length, sampleRate]);
  }

  async decodeAudioData(data: ArrayBuffer) {
    FakeOffline.decoded.push(data);
    return buffer(FakeOffline.channels);
  }
}

const reset = (): void => {
  FakeRecorder.last = null;
  FakeRecorder.throwOnConstruct = undefined;
  FakeRecorder.throwOnStop = undefined;
  FakeRecorder.emitOnStop = [];
  FakeOffline.args = [];
  FakeOffline.decoded = [];
  FakeOffline.channels = [[0.5, 0.5]];
};

const fakeGlobal = (stream: FakeStream, overrides: Partial<AudioCaptureGlobalLike> = {}): AudioCaptureGlobalLike => ({
  navigator: { mediaDevices: { getUserMedia: async () => stream } },
  MediaRecorder: FakeRecorder,
  OfflineAudioContext: FakeOffline,
  ...overrides,
});

describe('canCaptureAudio', () => {
  it('is true when every piece exists', () => {
    should(canCaptureAudio(fakeGlobal(new FakeStream()))).be.true();
  });

  it('is false for each missing piece', () => {
    const stream = new FakeStream();
    should(canCaptureAudio({})).be.false();
    should(canCaptureAudio({ ...fakeGlobal(stream), navigator: undefined })).be.false();
    should(canCaptureAudio({ ...fakeGlobal(stream), navigator: {} })).be.false();
    should(canCaptureAudio({ ...fakeGlobal(stream), navigator: { mediaDevices: {} as never } })).be.false();
    should(canCaptureAudio({ ...fakeGlobal(stream), MediaRecorder: undefined })).be.false();
    should(canCaptureAudio({ ...fakeGlobal(stream), OfflineAudioContext: undefined })).be.false();
  });
});

describe('browserAudioCapture', () => {
  it('rejects with NotSupportedError when an API is missing', async () => {
    reset();
    const stream = new FakeStream();
    for (const missing of [
      { navigator: undefined },
      { navigator: {} },
      { MediaRecorder: undefined },
      { OfflineAudioContext: undefined },
    ] as Partial<AudioCaptureGlobalLike>[]) {
      await should(browserAudioCapture(fakeGlobal(stream, missing)).start()).be.rejectedWith({
        name: 'NotSupportedError',
      });
    }
  });

  it('asks for one clean channel of audio', async () => {
    reset();
    let asked: MediaStreamConstraints | undefined;
    const stream = new FakeStream();
    const capture = browserAudioCapture(
      fakeGlobal(stream, {
        navigator: {
          mediaDevices: {
            getUserMedia: async constraints => {
              asked = constraints;
              return stream;
            },
          },
        },
      }),
    );
    await capture.start();
    should(asked).eql({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    should(FakeRecorder.last?.started).equal(1);
  });

  it('passes the browser permission error through', async () => {
    reset();
    const denied = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    const capture = browserAudioCapture(
      fakeGlobal(new FakeStream(), {
        navigator: {
          mediaDevices: {
            getUserMedia: async () => {
              throw denied;
            },
          },
        },
      }),
    );
    await should(capture.start()).be.rejectedWith({ name: 'NotAllowedError' });
  });

  it('releases the tracks and rethrows when the recorder cannot be constructed', async () => {
    reset();
    const failure = new Error('unsupported mime');
    FakeRecorder.throwOnConstruct = failure;
    const stream = new FakeStream();
    await should(browserAudioCapture(fakeGlobal(stream)).start()).be.rejectedWith(failure);
    should(stream.stopped).equal(2);
  });

  it('stop collects the chunks, releases the microphone, decodes at 16 kHz and returns mono', async () => {
    reset();
    const stream = new FakeStream();
    const recording = await browserAudioCapture(fakeGlobal(stream)).start();
    const recorder = FakeRecorder.last as FakeRecorder;
    recorder.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    recorder.ondataavailable?.({ data: new Blob([]) });
    recorder.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])]) });
    FakeOffline.channels = [
      [1, 0],
      [0, 1],
    ];
    const samples = await recording.stop();
    should(Array.from(samples)).eql([0.5, 0.5]);
    should(stream.stopped).equal(2);
    should(FakeOffline.args).eql([[1, PARAKEET_SAMPLE_RATE, PARAKEET_SAMPLE_RATE]]);
    should(FakeOffline.args[0]).eql([1, 16_000, 16_000]);
    should(Array.from(new Uint8Array(FakeOffline.decoded[0] as ArrayBuffer))).eql([1, 2, 3, 4, 5]);
  });

  it('returns an empty array for an empty recording without decoding', async () => {
    reset();
    const stream = new FakeStream();
    const recording = await browserAudioCapture(fakeGlobal(stream)).start();
    should((await recording.stop()).length).equal(0);
    should(FakeOffline.args).have.length(0);
    should(stream.stopped).equal(2);
  });

  it('a second stop is empty and does not touch the recorder again', async () => {
    reset();
    const recording = await browserAudioCapture(fakeGlobal(new FakeStream())).start();
    await recording.stop();
    should((await recording.stop()).length).equal(0);
    should(FakeRecorder.last?.stops).equal(1);
  });

  it('a recorder error while stopping rejects with its error and releases the microphone', async () => {
    reset();
    const stream = new FakeStream();
    const recording = await browserAudioCapture(fakeGlobal(stream)).start();
    const recorder = FakeRecorder.last as FakeRecorder;
    const failure = new Error('encoder died');
    recorder.stop = () => recorder.onerror?.({ error: failure });
    await should(recording.stop()).be.rejectedWith(failure);
    should(stream.stopped).equal(2);
  });

  it('a recorder error event with no error object rejects with the event itself', async () => {
    reset();
    const recording = await browserAudioCapture(fakeGlobal(new FakeStream())).start();
    const recorder = FakeRecorder.last as FakeRecorder;
    const event = { type: 'error' };
    recorder.stop = () => recorder.onerror?.(event);
    await should(recording.stop()).be.rejectedWith(event as never);
  });

  it('a recorder error after the take ended releases the microphone and nothing waits', async () => {
    reset();
    const stream = new FakeStream();
    await browserAudioCapture(fakeGlobal(stream)).start();
    (FakeRecorder.last as FakeRecorder).onerror?.(null);
    should(stream.stopped).equal(2);
  });

  it('cancel stops the recorder and releases the microphone through onstop', async () => {
    reset();
    const stream = new FakeStream();
    const recording = await browserAudioCapture(fakeGlobal(stream)).start();
    recording.cancel();
    should(FakeRecorder.last?.stops).equal(1);
    should(stream.stopped).equal(2);
  });

  it('cancel releases the microphone when the recorder will not stop', async () => {
    reset();
    const stream = new FakeStream();
    const recording = await browserAudioCapture(fakeGlobal(stream)).start();
    FakeRecorder.throwOnStop = new Error('InvalidStateError');
    recording.cancel();
    should(stream.stopped).equal(2);
  });

  it('cancel twice, or after stop, is a no-op', async () => {
    reset();
    const first = new FakeStream();
    const cancelled = await browserAudioCapture(fakeGlobal(first)).start();
    cancelled.cancel();
    cancelled.cancel();
    should(FakeRecorder.last?.stops).equal(1);
    should((await cancelled.stop()).length).equal(0);

    const second = new FakeStream();
    const stopped = await browserAudioCapture(fakeGlobal(second)).start();
    await stopped.stop();
    stopped.cancel();
    should(FakeRecorder.last?.stops).equal(1);
  });
});
