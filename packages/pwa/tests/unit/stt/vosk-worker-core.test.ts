/**
 * Proves the Vosk worker's behaviour with a fake runtime: it parses only messages it understands,
 * loads the verified install once (and retries a failed load), says which failure stopped it, streams
 * each utterance — committed words at endpoints, interim words after them, posted only on a change —
 * finishes with every word in order, frees what it is told to close, and handles one message at a time.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type {
  VoskHeard,
  VoskLoadedModel,
  VoskRuntime,
  VoskStreamingRecognizer,
} from '../../../src/lib/stt/vosk-runtime.ts';
import {
  parseVoskRequest,
  VOSK_SAMPLE_RATE,
  VoskWorkerCore,
  type VoskWorkerReply,
} from '../../../src/lib/stt/vosk-worker-core.ts';

class FakeRecognizer implements VoskStreamingRecognizer {
  /** What each `accept` answers, in order; then interim nothing. */
  heard: (VoskHeard | Error)[] = [];
  tail = 'and the rest';
  finishThrows: Error | null = null;
  readonly fed: Float32Array[] = [];
  frees = 0;
  accept(samples: Float32Array): VoskHeard {
    this.fed.push(samples);
    const next = this.heard.shift() ?? { endpoint: false, text: '' };
    if (next instanceof Error) throw next;
    return next;
  }
  finish(): string {
    if (this.finishThrows !== null) throw this.finishThrows;
    this.frees += 1;
    return this.tail;
  }
  free(): void {
    this.frees += 1;
  }
}

class FakeRuntime implements VoskRuntime {
  loads = 0;
  failures: unknown[] = [];
  recognizerThrows: unknown = null;
  readonly recognizers: FakeRecognizer[] = [];
  readonly rates: number[] = [];
  load(): Promise<VoskLoadedModel> {
    this.loads += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({
      recognizer: rate => {
        if (this.recognizerThrows !== null) throw this.recognizerThrows;
        this.rates.push(rate);
        const recognizer = new FakeRecognizer();
        this.recognizers.push(recognizer);
        return recognizer;
      },
    });
  }
}

const setup = () => {
  const runtime = new FakeRuntime();
  const posted: VoskWorkerReply[] = [];
  let reads = 0;
  const core = new VoskWorkerCore({
    read: async () => {
      reads += 1;
      return new Map([['model', new Uint8Array([1])]]);
    },
    runtime,
    post: reply => posted.push(reply),
  });
  return { core, runtime, posted, reads: () => reads };
};

const samples = (...values: number[]): Float32Array => new Float32Array(values);

describe('parseVoskRequest', () => {
  it('reads each message the page sends', () => {
    const audio = samples(0.1);
    should(parseVoskRequest({ type: 'load' })).eql({ type: 'load' });
    should(parseVoskRequest({ type: 'open', id: 1 })).eql({ type: 'open', id: 1 });
    should(parseVoskRequest({ type: 'audio', id: 2, samples: audio })).eql({ type: 'audio', id: 2, samples: audio });
    should(parseVoskRequest({ type: 'finish', id: 3 })).eql({ type: 'finish', id: 3 });
    should(parseVoskRequest({ type: 'close', id: 4 })).eql({ type: 'close', id: 4 });
  });

  it('ignores anything else', () => {
    for (const data of [
      null,
      'load',
      { type: 'open' },
      { type: 'open', id: 1.5 },
      { type: 'audio', id: 1, samples: [0.1] },
      { type: 'transcribe', id: 1 },
    ])
      should(parseVoskRequest(data)).be.null();
  });
});

describe('VoskWorkerCore loading', () => {
  it('loads the verified install once and says it is ready', async () => {
    const { core, runtime, posted, reads } = setup();
    await core.handle({ type: 'load' });
    await core.handle({ type: 'load' });
    should(posted).eql([{ type: 'ready' }, { type: 'ready' }]);
    should(runtime.loads).equal(1);
    should(reads()).equal(1);
  });

  it('says which failure stopped a load, and genuinely retries the next one', async () => {
    const { core, runtime, posted } = setup();
    runtime.failures = [
      Object.assign(new Error('Vosk is not installed on this device.'), { code: 'not-installed' }),
      Object.assign(new Error('Model changed on this device.'), { code: 'integrity' }),
      Object.assign(new Error('out of memory'), { code: 'quota' }),
      524_928,
    ];
    await core.handle({ type: 'load' });
    await core.handle({ type: 'open', id: 7 });
    await core.handle({ type: 'load' });
    await core.handle({ type: 'load' });
    await core.handle({ type: 'load' });
    should(posted).eql([
      { type: 'failed', id: null, code: 'not-installed', message: 'Vosk is not installed on this device.' },
      { type: 'failed', id: 7, code: 'integrity', message: 'Model changed on this device.' },
      { type: 'failed', id: null, code: 'load-failed', message: 'out of memory' },
      { type: 'failed', id: null, code: 'load-failed', message: 'The Vosk speech model could not be loaded.' },
      { type: 'ready' },
    ]);
    should(runtime.loads).equal(5);
  });

  it('ignores a message it does not understand', async () => {
    const { core, posted } = setup();
    await core.handle({ type: 'nope' });
    should(posted).eql([]);
  });
});

describe('VoskWorkerCore streaming', () => {
  it('opens a recognizer at 16 kHz and posts interim, then committed, words — only when they change', async () => {
    const { core, runtime, posted } = setup();
    await core.handle({ type: 'open', id: 1 });
    should(runtime.rates).eql([VOSK_SAMPLE_RATE]);
    const recognizer = runtime.recognizers[0] as FakeRecognizer;
    recognizer.heard = [
      { endpoint: false, text: 'restart' },
      { endpoint: false, text: 'restart' },
      { endpoint: false, text: 'restart the' },
      { endpoint: true, text: 'restart the daemon' },
      { endpoint: true, text: '' },
      { endpoint: false, text: 'on the' },
      { endpoint: true, text: 'on the box' },
    ];
    for (let chunk = 0; chunk < 7; chunk += 1) await core.handle({ type: 'audio', id: 1, samples: samples(chunk) });
    should(recognizer.fed).have.length(7);
    should(posted).eql([
      { type: 'heard', id: 1, committed: '', interim: 'restart' },
      { type: 'heard', id: 1, committed: '', interim: 'restart the' },
      { type: 'heard', id: 1, committed: 'restart the daemon', interim: '' },
      { type: 'heard', id: 1, committed: 'restart the daemon', interim: 'on the' },
      { type: 'heard', id: 1, committed: 'restart the daemon on the box', interim: '' },
    ]);
    await core.handle({ type: 'finish', id: 1 });
    should(posted.at(-1)).eql({ type: 'result', id: 1, text: 'restart the daemon on the box and the rest' });
    should(recognizer.frees).equal(1);
    // The utterance is over: more of it has nobody to hear it.
    await core.handle({ type: 'audio', id: 1, samples: samples(1) });
    should(recognizer.fed).have.length(7);
  });

  it('finishes an utterance that heard nothing with nothing', async () => {
    const { core, runtime, posted } = setup();
    await core.handle({ type: 'open', id: 2 });
    (runtime.recognizers[0] as FakeRecognizer).tail = '';
    await core.handle({ type: 'finish', id: 2 });
    should(posted).eql([{ type: 'result', id: 2, text: '' }]);
  });

  it('refuses to finish an utterance it does not have', async () => {
    const { core, posted } = setup();
    await core.handle({ type: 'finish', id: 9 });
    should(posted).eql([{ type: 'failed', id: 9, code: 'transcribe-failed', message: 'Dictation already ended.' }]);
  });

  it('closes an utterance without a result, freeing it, and ignores closing one it does not have', async () => {
    const { core, runtime, posted } = setup();
    await core.handle({ type: 'open', id: 3 });
    await core.handle({ type: 'close', id: 3 });
    await core.handle({ type: 'close', id: 3 });
    should((runtime.recognizers[0] as FakeRecognizer).frees).equal(1);
    should(posted).eql([]);
  });

  it('replaces a recognizer opened again under the same id', async () => {
    const { core, runtime } = setup();
    await core.handle({ type: 'open', id: 4 });
    await core.handle({ type: 'open', id: 4 });
    should(runtime.recognizers.map(recognizer => recognizer.frees)).eql([1, 0]);
  });

  it('fails an utterance whose audio or finish the runtime cannot take, and frees it', async () => {
    const { core, runtime, posted } = setup();
    await core.handle({ type: 'open', id: 5 });
    (runtime.recognizers[0] as FakeRecognizer).heard = [new Error('memory access out of bounds')];
    await core.handle({ type: 'audio', id: 5, samples: samples(1) });
    await core.handle({ type: 'open', id: 6 });
    (runtime.recognizers[1] as FakeRecognizer).finishThrows = new Error('');
    await core.handle({ type: 'finish', id: 6 });
    should(posted).eql([
      { type: 'failed', id: 5, code: 'transcribe-failed', message: 'memory access out of bounds' },
      { type: 'failed', id: 6, code: 'transcribe-failed', message: 'Vosk could not transcribe that.' },
    ]);
    should(runtime.recognizers.map(recognizer => recognizer.frees)).eql([1, 1]);
  });

  it('fails an utterance the model cannot open a recognizer for', async () => {
    const { core, runtime, posted } = setup();
    runtime.recognizerThrows = 'no memory';
    await core.handle({ type: 'open', id: 8 });
    runtime.recognizerThrows = new Error('Recognizer could not be created');
    await core.handle({ type: 'open', id: 9 });
    should(posted).eql([
      { type: 'failed', id: 8, code: 'load-failed', message: 'Vosk could not start listening.' },
      { type: 'failed', id: 9, code: 'load-failed', message: 'Recognizer could not be created' },
    ]);
  });

  it('handles one message at a time, in arrival order', async () => {
    const { core, runtime, posted } = setup();
    const opened = core.handle({ type: 'open', id: 1 });
    const fed = core.handle({ type: 'audio', id: 1, samples: samples(1) });
    const finished = core.handle({ type: 'finish', id: 1 });
    await Promise.all([opened, fed, finished]);
    should(runtime.recognizers[0]?.fed).have.length(1);
    should(posted).eql([{ type: 'result', id: 1, text: 'and the rest' }]);
  });
});
