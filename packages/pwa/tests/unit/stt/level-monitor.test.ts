/**
 * Proves the level tap: it hangs a read-only analyser off a stream someone else owns, never plays
 * it back, never stops the stream's tracks, and every way it can fail leaves the stream alone.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { browserMicMeter, type MeterStreamLike, streamMonitor } from '../../../src/lib/stt/level-monitor.ts';

class FakeSource {
  connected: unknown[] = [];
  disconnects = 0;
  throwOnDisconnect = false;
  constructor(readonly stream: unknown) {}
  connect(destination: unknown): void {
    this.connected.push(destination);
  }
  disconnect(): void {
    this.disconnects += 1;
    if (this.throwOnDisconnect) throw new Error('already gone');
  }
}

interface ContextBehaviour {
  constructThrows: boolean;
  sourceThrows: boolean;
  resume: 'absent' | 'ok' | 'rejects' | 'throws';
  closeRejects: boolean;
}

const behaviour: ContextBehaviour = {
  constructThrows: false,
  sourceThrows: false,
  resume: 'ok',
  closeRejects: false,
};

class FakeContext {
  static all: FakeContext[] = [];
  sources: FakeSource[] = [];
  analysers: object[] = [];
  resumes = 0;
  closes = 0;
  resume?: () => Promise<void>;

  constructor() {
    if (behaviour.constructThrows) throw new Error('no audio here');
    FakeContext.all.push(this);
    if (behaviour.resume === 'absent') return;
    this.resume = async () => {
      this.resumes += 1;
      if (behaviour.resume === 'throws') throw new Error('sync-ish');
      if (behaviour.resume === 'rejects') return Promise.reject(new Error('autoplay'));
    };
  }

  createMediaStreamSource(stream: unknown): FakeSource {
    if (behaviour.sourceThrows) throw new Error('stream ended');
    const source = new FakeSource(stream);
    this.sources.push(source);
    return source;
  }

  createAnalyser(): object {
    const analyser = { getFloatTimeDomainData: () => undefined };
    this.analysers.push(analyser);
    return analyser;
  }

  async close(): Promise<void> {
    this.closes += 1;
    if (behaviour.closeRejects) throw new Error('already closed');
  }
}

const reset = (): void => {
  FakeContext.all = [];
  Object.assign(behaviour, {
    constructThrows: false,
    sourceThrows: false,
    resume: 'ok',
    closeRejects: false,
  } satisfies ContextBehaviour);
};

const tracks = () => {
  const stopped: number[] = [];
  const stream: MeterStreamLike = {
    getTracks: () => [
      { stop: () => stopped.push(1) },
      {
        stop: () => {
          stopped.push(2);
          throw new Error('already stopped');
        },
      },
    ],
  };
  return { stream, stopped };
};

const AUDIO = { AudioContext: FakeContext as never };

describe('streamMonitor', () => {
  it('has nothing to offer a page without Web Audio', () => {
    should(streamMonitor(new MediaStream(), {})).be.null();
  });

  it('taps THE stream it was given with a read-only analyser, connected to nothing else', () => {
    reset();
    const stream = new MediaStream();
    const tap = streamMonitor(stream, AUDIO)?.createAnalyser();
    const context = FakeContext.all[0] as FakeContext;
    should(tap).not.be.null();
    should(context.sources[0]?.stream).equal(stream);
    should(context.sources[0]?.connected).eql(context.analysers);
    should(tap?.analyser).equal(context.analysers[0]);
    should(context.resumes).equal(1);
  });

  it('gives each analyser its own context, and closes only that one on disconnect', () => {
    reset();
    const monitor = streamMonitor(new MediaStream(), AUDIO);
    const first = monitor?.createAnalyser();
    monitor?.createAnalyser();
    should(FakeContext.all).have.length(2);
    first?.disconnect();
    should(FakeContext.all.map(context => context.closes)).eql([1, 0]);
    should(FakeContext.all[0]?.sources[0]?.disconnects).equal(1);
  });

  it('never throws out of disconnect, whatever state the graph is in', async () => {
    reset();
    behaviour.closeRejects = true;
    const tap = streamMonitor(new MediaStream(), AUDIO)?.createAnalyser();
    const source = FakeContext.all[0]?.sources[0];
    if (source !== undefined) source.throwOnDisconnect = true;
    tap?.disconnect();
    tap?.disconnect();
    await Promise.resolve();
    should(FakeContext.all[0]?.closes).equal(2);
  });

  it('copes with a context that cannot resume, whichever way it fails', async () => {
    for (const resume of ['absent', 'rejects', 'throws'] as const) {
      reset();
      behaviour.resume = resume;
      const tap = streamMonitor(new MediaStream(), AUDIO)?.createAnalyser();
      should(tap).not.be.null();
      await Promise.resolve();
    }
  });

  it('answers null, not an error, when the context cannot be built', () => {
    reset();
    behaviour.constructThrows = true;
    should(streamMonitor(new MediaStream(), AUDIO)?.createAnalyser()).be.null();
  });

  it('closes the context it built when the stream cannot be tapped', () => {
    reset();
    behaviour.sourceThrows = true;
    should(streamMonitor(new MediaStream(), AUDIO)?.createAnalyser()).be.null();
    should(FakeContext.all[0]?.closes).equal(1);
  });
});

describe('browserMicMeter', () => {
  it('is unavailable without a microphone API or without Web Audio', () => {
    const { stream } = tracks();
    const devices = { getUserMedia: async () => stream };
    should(browserMicMeter({})).be.null();
    should(browserMicMeter({ navigator: {} })).be.null();
    should(browserMicMeter({ navigator: { mediaDevices: {} as never }, ...AUDIO })).be.null();
    should(browserMicMeter({ navigator: { mediaDevices: devices } })).be.null();
  });

  it('opens one plain audio stream and taps it', async () => {
    reset();
    const { stream } = tracks();
    const asked: MediaStreamConstraints[] = [];
    const port = browserMicMeter({
      navigator: {
        mediaDevices: {
          getUserMedia: async constraints => {
            asked.push(constraints);
            return stream;
          },
        },
      },
      ...AUDIO,
    });
    const meter = await port?.open();
    should(asked).eql([{ audio: true }]);
    meter?.monitor.createAnalyser();
    should(FakeContext.all[0]?.sources[0]?.stream).equal(stream);
  });

  it('releases every track on release, even one that refuses to stop', async () => {
    reset();
    const { stream, stopped } = tracks();
    const meter = await browserMicMeter({
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
      ...AUDIO,
    })?.open();
    meter?.release();
    should(stopped).eql([1, 2]);
  });

  it('answers null when the microphone is refused, so the meter just does not appear', async () => {
    const port = browserMicMeter({
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
          },
        },
      },
      ...AUDIO,
    });
    should(await port?.open()).be.null();
  });
});
