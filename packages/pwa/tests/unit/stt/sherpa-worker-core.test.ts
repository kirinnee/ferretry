/**
 * Proves the sherpa worker's behaviour with a fake recognizer: it loads the named model once from the
 * verified install, answers in arrival order, streams the words so far as committed and interim
 * phrases, pads a stream with silence at both ends, sentence-cases an all-caps model, and turns every
 * failure into an answer the page can attribute.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseSherpaRequest,
  type SherpaLoadedModel,
  type SherpaStreamPort,
  SherpaWorkerCore,
  type SherpaWorkerReply,
  sentenceCase,
  STREAM_LEAD_SAMPLES,
  STREAM_TAIL_SAMPLES,
} from '../../../src/lib/stt/sherpa-worker-core.ts';
import { type SherpaCatalogModel, SHERPA_ZIPFORMER_MODEL } from '../../../src/lib/stt/sherpa-models.ts';

/** A stream that hears scripted phrases: each push reveals the next text, `endpoint` closes it. */
class FakeStream implements SherpaStreamPort {
  readonly accepted: number[] = [];
  readonly script: { text: string; endpoint?: boolean }[];
  current = '';
  endpoint = false;
  resets = 0;
  finished = 0;
  freed = 0;
  failOnAccept = false;

  constructor(script: { text: string; endpoint?: boolean }[]) {
    this.script = script;
  }
  accept(samples: Float32Array): void {
    if (this.failOnAccept) throw new Error('decoder exploded');
    this.accepted.push(samples.length);
  }
  decode(): void {
    const next = this.script.shift();
    if (next === undefined) return;
    this.current = next.text;
    this.endpoint = next.endpoint === true;
  }
  text(): string {
    return this.current;
  }
  isEndpoint(): boolean {
    return this.endpoint;
  }
  reset(): void {
    this.resets += 1;
    this.current = '';
  }
  inputFinished(): void {
    this.finished += 1;
  }
  free(): void {
    this.freed += 1;
  }
}

const harness = (
  options: {
    loaded?: SherpaLoadedModel;
    read?: () => Promise<{ runtime: Uint8Array; files: ReadonlyMap<string, Uint8Array> }>;
    load?: () => Promise<SherpaLoadedModel>;
    lookup?: (id: string) => SherpaCatalogModel | null;
  } = {},
) => {
  const replies: SherpaWorkerReply[] = [];
  let clock = 100;
  let loads = 0;
  const streams: FakeStream[] = [];
  const scripts: { text: string; endpoint?: boolean }[][] = [];
  const loaded: SherpaLoadedModel = options.loaded ?? {
    openStream: () => {
      const stream = new FakeStream(scripts.shift() ?? []);
      streams.push(stream);
      return stream;
    },
    transcribe: () => null,
  };
  const core = new SherpaWorkerCore({
    read:
      options.read ??
      (async () => ({ runtime: new Uint8Array([1]), files: new Map([['tokens', new Uint8Array([2])]]) })),
    runtime: {
      load:
        options.load ??
        (async () => {
          loads += 1;
          clock += 40;
          return loaded;
        }),
    },
    post: reply => replies.push(reply),
    now: () => clock,
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
  });
  return { core, replies, streams, scripts, loads: () => loads };
};

const load = { type: 'load', model: 'sherpa-zipformer-en' } as const;

describe('parseSherpaRequest', () => {
  it('accepts exactly the messages the page sends', () => {
    const samples = new Float32Array(2);
    should(parseSherpaRequest(load)).eql(load);
    should(parseSherpaRequest({ type: 'transcribe', id: 1, samples })).eql({ type: 'transcribe', id: 1, samples });
    should(parseSherpaRequest({ type: 'stream-open', id: 2 })).eql({ type: 'stream-open', id: 2 });
    should(parseSherpaRequest({ type: 'stream-push', id: 2, samples })).eql({ type: 'stream-push', id: 2, samples });
    should(parseSherpaRequest({ type: 'stream-close', id: 2 })).eql({ type: 'stream-close', id: 2 });
    should(parseSherpaRequest({ type: 'stream-drop', id: 2 })).eql({ type: 'stream-drop', id: 2 });
  });

  it('ignores anything else', () => {
    for (const data of [
      null,
      'load',
      { type: 'load' },
      { type: 'transcribe', id: 1, samples: [1] },
      { type: 'stream-push', id: 1.5, samples: new Float32Array(1) },
      { type: 'stream-open' },
      { type: 'nope', id: 1 },
    ])
      should(parseSherpaRequest(data)).be.null();
  });
});

describe('sentenceCase', () => {
  it('lower-cases capitals, capitalises a sentence start and the pronoun I', () => {
    should(sentenceCase("I THINK I'M DONE SO I LEFT", true)).equal("I think I'm done so I left");
    should(sentenceCase('AND THEN IT RAINED', false)).equal('and then it rained');
    should(sentenceCase('', true)).equal('');
  });
});

describe('SherpaWorkerCore', () => {
  it('loads the named model once, reports how long it took, and ignores what it cannot parse', async () => {
    const h = harness();
    await h.core.handle({ nonsense: true });
    await h.core.handle(load);
    await h.core.handle(load);
    should(h.loads()).equal(1);
    should(h.replies).eql([{ type: 'ready', loadMs: 40 }]);
  });

  it('streams committed and interim words, padding the stream with silence at both ends', async () => {
    const h = harness();
    h.scripts.push([
      { text: 'HELLO' },
      { text: 'HELLO THERE', endpoint: true },
      { text: 'I AM' },
      { text: 'I AM HERE' },
    ]);
    await h.core.handle(load);
    await h.core.handle({ type: 'stream-open', id: 7 });
    for (let index = 0; index < 3; index += 1)
      await h.core.handle({ type: 'stream-push', id: 7, samples: new Float32Array(10) });
    await h.core.handle({ type: 'stream-close', id: 7 });
    const [stream] = h.streams;
    should(stream?.accepted).eql([STREAM_LEAD_SAMPLES, 10, 10, 10, STREAM_TAIL_SAMPLES]);
    should(stream?.resets).equal(1);
    should(stream?.finished).equal(1);
    should(stream?.freed).equal(1);
    should(h.replies.slice(1)).eql([
      { type: 'partial', id: 7, committed: '', interim: 'Hello' },
      { type: 'partial', id: 7, committed: 'Hello there', interim: '' },
      { type: 'partial', id: 7, committed: 'Hello there', interim: 'I am' },
      { type: 'result', id: 7, text: 'Hello there I am here' },
    ]);
  });

  it('keeps a model’s own casing when it is not all capitals', async () => {
    const h = harness({ lookup: () => ({ ...SHERPA_ZIPFORMER_MODEL, textCase: 'as-is' }) });
    h.scripts.push([{ text: 'Hello, World.' }]);
    await h.core.handle(load);
    await h.core.handle({ type: 'stream-open', id: 1 });
    await h.core.handle({ type: 'stream-close', id: 1 });
    should(h.replies.at(-1)).eql({ type: 'result', id: 1, text: 'Hello, World.' });
  });

  it('drops a stream without answering, and refuses a push or close for a stream that is not open', async () => {
    const h = harness();
    await h.core.handle(load);
    await h.core.handle({ type: 'stream-open', id: 3 });
    await h.core.handle({ type: 'stream-drop', id: 3 });
    await h.core.handle({ type: 'stream-drop', id: 99 });
    should(h.streams[0]?.freed).equal(1);
    await h.core.handle({ type: 'stream-push', id: 3, samples: new Float32Array(1) });
    await h.core.handle({ type: 'stream-close', id: 4 });
    should(h.replies.slice(1)).eql([
      { type: 'failed', id: 3, code: 'transcribe-failed', message: 'That stream is not open.' },
      { type: 'failed', id: 4, code: 'transcribe-failed', message: 'That stream is not open.' },
    ]);
  });

  it('frees a stream whose decode failed, and answers that failure to its request', async () => {
    const h = harness();
    await h.core.handle(load);
    await h.core.handle({ type: 'stream-open', id: 5 });
    const stream = h.streams[0];
    if (stream !== undefined) stream.failOnAccept = true;
    await h.core.handle({ type: 'stream-push', id: 5, samples: new Float32Array(1) });
    should(stream?.freed).equal(1);
    should(h.replies.at(-1)).eql({ type: 'failed', id: 5, code: 'transcribe-failed', message: 'decoder exploded' });
  });

  it('transcribes a whole take on a model that can, and explains each mismatch of model and request', async () => {
    const whole = harness({ loaded: { openStream: () => null, transcribe: () => '  GOOD MORNING  ' } });
    await whole.core.handle(load);
    await whole.core.handle({ type: 'transcribe', id: 1, samples: new Float32Array(1) });
    await whole.core.handle({ type: 'stream-open', id: 2 });
    should(whole.replies.slice(1)).eql([
      { type: 'result', id: 1, text: 'Good morning' },
      {
        type: 'failed',
        id: 2,
        code: 'transcribe-failed',
        message: 'This model transcribes after you stop; it cannot listen while you speak.',
      },
    ]);
    const streaming = harness();
    await streaming.core.handle(load);
    await streaming.core.handle({ type: 'transcribe', id: 3, samples: new Float32Array(1) });
    should(streaming.replies.at(-1)).eql({
      type: 'failed',
      id: 3,
      code: 'transcribe-failed',
      message: 'This model only listens while you speak; it cannot transcribe a whole take.',
    });
  });

  it('reports a failed load with the store’s own code, and tries again on the next request', async () => {
    let attempt = 0;
    const h = harness({
      read: async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error('Not installed.'), { code: 'not-installed' });
        if (attempt === 2) throw Object.assign(new Error('Changed on disk.'), { code: 'integrity' });
        if (attempt === 3) throw new Error('');
        return { runtime: new Uint8Array(), files: new Map() };
      },
    });
    await h.core.handle(load);
    await h.core.handle({ type: 'stream-open', id: 1 });
    await h.core.handle({ type: 'stream-open', id: 2 });
    await h.core.handle({ type: 'stream-open', id: 3 });
    should(h.replies).eql([
      { type: 'failed', id: null, code: 'not-installed', message: 'Not installed.' },
      { type: 'failed', id: 1, code: 'integrity', message: 'Changed on disk.' },
      { type: 'failed', id: 2, code: 'load-failed', message: 'The on-device speech model could not be loaded.' },
      { type: 'ready', loadMs: 40 },
    ]);
  });

  it('refuses work before any sherpa model is named', async () => {
    const h = harness();
    await h.core.handle({ type: 'load', model: 'nope' });
    await h.core.handle({ type: 'stream-open', id: 1 });
    should(h.replies.at(-1)).eql({
      type: 'failed',
      id: 1,
      code: 'load-failed',
      message: 'No sherpa model was named before the first request.',
    });
  });

  it('says a plain failure in plain words', async () => {
    const h = harness({
      loaded: {
        openStream: () => null,
        transcribe: () => {
          throw 'not an error';
        },
      },
    });
    await h.core.handle(load);
    await h.core.handle({ type: 'transcribe', id: 1, samples: new Float32Array(1) });
    should(h.replies.at(-1)).eql({
      type: 'failed',
      id: 1,
      code: 'transcribe-failed',
      message: 'The on-device speech model could not transcribe that.',
    });
  });
});
