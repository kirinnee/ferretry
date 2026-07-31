/**
 * A stand-in for the native recognizer, shaped exactly like the sherpa export
 * the factory expects. It proves the whole worker path — spawn, IPC, load,
 * decode, shutdown — without the 600 MB weights or the native addon.
 *
 * The real worker entry loads it through FY_STT_RECOGNIZER_MODULE. With
 * FY_STT_FIXTURE_HANG=1 the load never returns, which is how the supervisor's
 * reaping of an unresponsive child is proven against a real process.
 */
export const HANG_VARIABLE = 'FY_STT_FIXTURE_HANG';

class FakeStream {
  sampleRate = 0;
  samples: Float32Array<ArrayBufferLike> = new Float32Array(0);

  acceptWaveform(input: { sampleRate: number; samples: Float32Array<ArrayBufferLike> }): void {
    this.sampleRate = input.sampleRate;
    this.samples = input.samples;
  }
}

export class OfflineRecognizer {
  constructor(readonly config: unknown) {
    while (process.env[HANG_VARIABLE] === '1') {
      // Deliberately unresponsive: only a kill ends this process.
    }
  }

  createStream(): FakeStream {
    return new FakeStream();
  }

  decode(stream: FakeStream): void {
    if (stream.samples.length === 0) throw new Error('nothing was accepted before decoding');
  }

  getResult(stream: FakeStream): { text: string } {
    return { text: `decoded ${stream.samples.length} samples at ${stream.sampleRate}` };
  }
}
