import { describe, it } from 'bun:test';
import should from 'should';
import {
  CAPTURE_AUDIO_CONSTRAINTS,
  type CaptureAnalyserTap,
  type CaptureGraph,
  type CaptureHost,
  hasMicrophoneApi,
  type MicrophoneStream,
  noMicrophoneApiError,
  startCapture,
  type StartCaptureOptions,
} from '../../../src/lib/stt/audio-capture.ts';
import { CaptureError } from '../../../src/lib/stt/capture-error.ts';
import { MAX_UTTERANCE_SECONDS, TARGET_SAMPLE_RATE } from '../../../src/lib/stt/pcm.ts';

const tone = (length: number, value = 0.5): Float32Array => new Float32Array(length).fill(value);

class FakeGraph implements CaptureGraph {
  released = 0;
  flushes = 0;
  analysers = 0;
  readonly taps: CaptureAnalyserTap[] = [];
  /** Delivered by `flush()`, the way a worklet delivers its batched tail. */
  tail: Float32Array | null = null;
  flushRejects = false;
  analyserFails = false;

  #sink: (samples: Float32Array) => void = () => undefined;

  constructor(readonly inputSampleRate = TARGET_SAMPLE_RATE) {}

  attach(sink: (samples: Float32Array) => void): void {
    this.#sink = sink;
  }

  /** The graph delivering a batch, exactly as a worklet message would. */
  deliver(samples: Float32Array): void {
    this.#sink(samples);
  }

  async flush(): Promise<void> {
    this.flushes += 1;
    if (this.flushRejects) throw new Error('the port is already gone');
    if (this.tail !== null) this.#sink(this.tail);
  }

  createAnalyser(): CaptureAnalyserTap | null {
    if (this.analyserFails) return null;
    this.analysers += 1;
    const tap: CaptureAnalyserTap = { analyser: { id: this.analysers }, disconnect: () => undefined };
    this.taps.push(tap);
    return tap;
  }

  release(): void {
    this.released += 1;
  }
}

interface Rig {
  readonly host: CaptureHost;
  readonly graph: FakeGraph;
  readonly microphone: MicrophoneStream;
  /** Fires the host's tab-hidden notification. */
  hide(): void;
  readonly unwatches: number[];
}

const rig = (
  overrides: { sampleRate?: number; openFails?: unknown; buildFails?: unknown } = {},
): Rig & { readonly state: { unwatched: number } } => {
  const graph = new FakeGraph(overrides.sampleRate ?? TARGET_SAMPLE_RATE);
  const microphone: MicrophoneStream = { stream: { id: 'device-stream' } };
  const state = { unwatched: 0 };
  let onHidden: (() => void) | null = null;

  const host: CaptureHost = {
    openMicrophone: async () => {
      if (overrides.openFails !== undefined) throw overrides.openFails;
      return microphone;
    },
    buildGraph: async (_microphone, sink) => {
      if (overrides.buildFails !== undefined) throw overrides.buildFails;
      graph.attach(sink);
      return graph;
    },
    watchHidden: callback => {
      onHidden = callback;
      return () => {
        state.unwatched += 1;
        onHidden = null;
      };
    },
  };

  return {
    host,
    graph,
    microphone,
    state,
    unwatches: [],
    hide: () => onHidden?.(),
  };
};

const start = (test: Rig, options: StartCaptureOptions = {}) => startCapture(test.host, options);

describe('hasMicrophoneApi', () => {
  it('is false where the API is absent rather than restricted', () => {
    should(hasMicrophoneApi(undefined)).be.false();
    should(hasMicrophoneApi({})).be.false();
    should(hasMicrophoneApi({ mediaDevices: {} })).be.false();
    should(hasMicrophoneApi({ mediaDevices: { getUserMedia: () => undefined } })).be.true();
  });
});

describe('capture constants', () => {
  it('asks for the mono, processed stream a speech model wants', () => {
    should(CAPTURE_AUDIO_CONSTRAINTS.channelCount).equal(1);
    should(CAPTURE_AUDIO_CONSTRAINTS.echoCancellation).be.true();
  });

  it('names the refusal a host raises for a page with no microphone API', () => {
    const failure = noMicrophoneApiError();
    should(failure).be.instanceof(CaptureError);
    should(failure.code).equal('no-media-devices');
  });
});

describe('startCapture', () => {
  it('collects an utterance and returns it at the target rate', async () => {
    const test = rig();
    const session = await start(test);

    should(session.active).be.true();
    should(session.stream).equal(test.microphone.stream);
    test.graph.deliver(tone(1_000));

    const samples = await session.stop();
    should(samples).have.length(1_000);
    should(session.active).be.false();
  });

  it('resamples a graph that runs at another rate', async () => {
    const test = rig({ sampleRate: 48_000 });
    const session = await start(test);
    should(session.inputSampleRate).equal(48_000);

    test.graph.deliver(tone(4_800));
    should(await session.stop()).have.length(1_600);
  });

  it('falls back to the target rate for a graph that will not say', async () => {
    const test = rig({ sampleRate: 0 });
    const session = await start(test);
    should(session.inputSampleRate).equal(TARGET_SAMPLE_RATE);
  });

  it('KEEPS THE TAIL that arrives during the flush, after the microphone closed', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.deliver(tone(800));
    test.graph.tail = tone(200);

    const samples = await session.stop();
    should(samples).have.length(1_000);
    should(test.graph.flushes).equal(1);
  });

  it('shares one flush between concurrent and repeated stops', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.deliver(tone(400));

    const [first, second] = await Promise.all([session.stop(), session.stop()]);
    should(test.graph.flushes).equal(1);
    should(first).equal(second);
    should(await session.stop()).equal(first);
  });

  it('still returns the audio when the graph cannot be flushed', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.deliver(tone(300));
    test.graph.flushRejects = true;

    should(await session.stop()).have.length(300);
  });

  it('releases the device exactly once, however many times it is asked', async () => {
    const test = rig();
    const session = await start(test);

    await session.stop();
    session.cancel();
    await session.stop();

    should(test.graph.released).equal(1);
    should(test.state.unwatched).equal(1);
  });

  it('publishes every accepted batch to the live observer, copied', async () => {
    const test = rig();
    const seen: Float32Array[] = [];
    const session = await start(test, { onSamples: samples => void seen.push(samples) });

    const batch = tone(10);
    test.graph.deliver(batch);
    batch.fill(0);

    should(seen).have.length(1);
    should(seen[0]).not.equal(batch);
    should(seen[0]?.[0]).equal(0.5);
    await session.stop();
  });

  it('never lets an observer strand the microphone', async () => {
    const test = rig();
    const session = await start(test, {
      onSamples: () => {
        throw new Error('the segmenter fell over');
      },
    });

    test.graph.deliver(tone(100));
    should(await session.stop()).have.length(100);
  });

  it('stops itself at the hard ceiling and tells the caller afterwards', async () => {
    const test = rig();
    const limits: string[] = [];
    const seen: number[] = [];
    const session = await start(test, {
      onLimit: () => limits.push('limit'),
      onSamples: samples => void seen.push(samples.length),
    });

    const ceiling = MAX_UTTERANCE_SECONDS * TARGET_SAMPLE_RATE;
    test.graph.deliver(tone(ceiling + 5_000));

    should(limits).deepEqual(['limit']);
    should(seen).deepEqual([ceiling]);
    // Closed to the caller, but still accepting the tail.
    should(session.active).be.false();

    test.graph.deliver(tone(1_000));
    should(seen).deepEqual([ceiling]);
    should(await session.stop()).have.length(ceiling);
  });

  it('ignores an empty batch', async () => {
    const test = rig();
    const seen: number[] = [];
    const session = await start(test, { onSamples: samples => void seen.push(samples.length) });

    test.graph.deliver(new Float32Array(0));
    should(seen).deepEqual([]);
    await session.stop();
  });

  it('throws the audio away on cancel, tail and all', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.deliver(tone(1_000));
    test.graph.tail = tone(500);

    session.cancel();
    should(session.active).be.false();
    should(await session.stop()).have.length(0);
    should(test.graph.flushes).equal(0);
    should(test.graph.released).equal(1);
  });

  it('abandons the utterance when the tab goes to the background, and says so once', async () => {
    const test = rig();
    const aborts: string[] = [];
    const session = await start(test, { onAbort: reason => void aborts.push(reason) });
    test.graph.deliver(tone(2_000));

    test.hide();

    should(aborts).deepEqual(['hidden']);
    should(session.active).be.false();
    should(await session.stop()).have.length(0);
    should(test.graph.released).equal(1);
  });

  it('does not announce a background hide after a normal stop', async () => {
    const test = rig();
    const aborts: string[] = [];
    const session = await start(test, { onAbort: reason => void aborts.push(reason) });

    await session.stop();
    test.hide();

    should(aborts).deepEqual([]);
  });

  it('discards an in-flight stop when the tab goes away mid-flush', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.deliver(tone(1_000));

    const stopping = session.stop();
    test.hide();
    await stopping;

    should(await session.stop()).have.length(0);
  });

  it('hands out analyser branches while the graph is alive, and none after', async () => {
    const test = rig();
    const session = await start(test);

    should(session.createAnalyser()).not.be.null();
    should(test.graph.analysers).equal(1);

    await session.stop();
    should(session.createAnalyser()).be.null();
  });

  it('passes a refused analyser branch through as null', async () => {
    const test = rig();
    const session = await start(test);
    test.graph.analyserFails = true;

    should(session.createAnalyser()).be.null();
    await session.stop();
  });

  it('releases and classifies a refused microphone', async () => {
    const test = rig({ openFails: { name: 'NotAllowedError' } });

    await start(test).then(
      () => {
        throw new Error('capture started without a microphone');
      },
      (error: unknown) => should((error as CaptureError).code).equal('permission-denied'),
    );
    should(test.graph.released).equal(0);
  });

  it('releases the microphone when the graph cannot be built', async () => {
    const test = rig({ buildFails: new CaptureError('audio-unavailable', 'This browser has no Web Audio support.') });

    await start(test).then(
      () => {
        throw new Error('capture started without a graph');
      },
      (error: unknown) => should((error as CaptureError).code).equal('audio-unavailable'),
    );
    should(test.state.unwatched).equal(0);
  });
});
