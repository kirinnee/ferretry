/**
 * Proves the speech worker's behaviour with the worker taken out: requests are parsed strictly,
 * the model loads lazily and once, a failed load is retried, failures carry the right code, and
 * messages are answered strictly in arrival order — all against a fake model.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { ParakeetModelBytes } from '../../../src/lib/stt/parakeet-store.ts';
import {
  type ParakeetLoadedModel,
  type ParakeetRuntime,
  ParakeetWorkerCore,
  type ParakeetWorkerReply,
  parseWorkerRequest,
} from '../../../src/lib/stt/parakeet-worker-core.ts';

const BYTES = { fake: 'bytes' } as unknown as ParakeetModelBytes;

interface Harness {
  readonly core: ParakeetWorkerCore;
  readonly replies: ParakeetWorkerReply[];
  readonly reads: () => number;
  readonly loads: () => number;
}

const harness = (options: {
  read?: () => Promise<ParakeetModelBytes>;
  load?: (bytes: ParakeetModelBytes) => Promise<ParakeetLoadedModel>;
  model?: ParakeetLoadedModel;
}): Harness => {
  const replies: ParakeetWorkerReply[] = [];
  let reads = 0;
  let loads = 0;
  const runtime: ParakeetRuntime = {
    load: async bytes => {
      loads += 1;
      if (options.load !== undefined) return await options.load(bytes);
      return options.model ?? { transcribe: async () => 'text' };
    },
  };
  const core = new ParakeetWorkerCore({
    read: async () => {
      reads += 1;
      return options.read === undefined ? BYTES : await options.read();
    },
    runtime,
    post: reply => replies.push(reply),
  });
  return { core, replies, reads: () => reads, loads: () => loads };
};

const samples = (): Float32Array => new Float32Array([0.1, 0.2]);

describe('parseWorkerRequest', () => {
  it('accepts a load request', () => {
    should(parseWorkerRequest({ type: 'load' })).eql({ type: 'load' });
  });

  it('accepts a transcribe request with a Float32Array', () => {
    const data = samples();
    const parsed = parseWorkerRequest({ type: 'transcribe', id: 3, samples: data });
    should(parsed).eql({ type: 'transcribe', id: 3, samples: data });
  });

  it('rejects a bad id, non-Float32Array samples, junk and null', () => {
    should(parseWorkerRequest({ type: 'transcribe', id: 1.5, samples: samples() })).be.null();
    should(parseWorkerRequest({ type: 'transcribe', id: '1', samples: samples() })).be.null();
    should(parseWorkerRequest({ type: 'transcribe', samples: samples() })).be.null();
    should(parseWorkerRequest({ type: 'transcribe', id: 1, samples: [0.1] })).be.null();
    should(parseWorkerRequest({ type: 'transcribe', id: 1, samples: new Float64Array(2) })).be.null();
    should(parseWorkerRequest({ type: 'other' })).be.null();
    should(parseWorkerRequest('load')).be.null();
    should(parseWorkerRequest(42)).be.null();
    should(parseWorkerRequest(null)).be.null();
    should(parseWorkerRequest(undefined)).be.null();
  });
});

describe('ParakeetWorkerCore', () => {
  it('ignores junk messages without answering', async () => {
    const h = harness({});
    await h.core.handle({ type: 'nope' });
    await h.core.handle(null);
    should(h.replies).eql([]);
    should(h.reads()).equal(0);
  });

  it('answers a load with ready', async () => {
    const h = harness({});
    await h.core.handle({ type: 'load' });
    should(h.replies).eql([{ type: 'ready' }]);
  });

  it('answers a transcribe with the trimmed text', async () => {
    const h = harness({ model: { transcribe: async () => '  hello there \n' } });
    await h.core.handle({ type: 'transcribe', id: 7, samples: samples() });
    should(h.replies).eql([{ type: 'result', id: 7, text: 'hello there' }]);
  });

  it('hands the decoded samples to the model', async () => {
    const seen: Float32Array[] = [];
    const h = harness({
      model: {
        transcribe: async s => {
          seen.push(s);
          return 'x';
        },
      },
    });
    const data = samples();
    await h.core.handle({ type: 'transcribe', id: 1, samples: data });
    should(seen[0]).equal(data);
  });

  it('loads the model once across messages', async () => {
    const h = harness({});
    await h.core.handle({ type: 'load' });
    await h.core.handle({ type: 'transcribe', id: 1, samples: samples() });
    await h.core.handle({ type: 'transcribe', id: 2, samples: samples() });
    should(h.reads()).equal(1);
    should(h.loads()).equal(1);
    should(h.replies.map(r => r.type)).eql(['ready', 'result', 'result']);
  });

  it('does not remember a failed load, so the next message retries', async () => {
    let attempts = 0;
    const h = harness({
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk gone');
        return BYTES;
      },
    });
    await h.core.handle({ type: 'load' });
    await h.core.handle({ type: 'load' });
    should(h.replies).eql([{ type: 'failed', id: null, code: 'load-failed', message: 'disk gone' }, { type: 'ready' }]);
    should(attempts).equal(2);
  });

  it('passes through not-installed and integrity codes', async () => {
    for (const code of ['not-installed', 'integrity'] as const) {
      const h = harness({
        read: async () => {
          throw Object.assign(new Error(`bad ${code}`), { code });
        },
      });
      await h.core.handle({ type: 'transcribe', id: 4, samples: samples() });
      should(h.replies).eql([{ type: 'failed', id: 4, code, message: `bad ${code}` }]);
    }
  });

  it('maps any other load failure to load-failed', async () => {
    const withUnknownCode = harness({
      load: async () => {
        throw Object.assign(new Error('boom'), { code: 'EIO' });
      },
    });
    await withUnknownCode.core.handle({ type: 'load' });
    should(withUnknownCode.replies).eql([{ type: 'failed', id: null, code: 'load-failed', message: 'boom' }]);

    const withNonStringCode = harness({
      load: async () => {
        throw Object.assign(new Error('boom'), { code: 5 });
      },
    });
    await withNonStringCode.core.handle({ type: 'load' });
    should(withNonStringCode.replies[0]).have.property('code', 'load-failed');
  });

  it('falls back to a fixed message for an empty message or a non-Error', async () => {
    const empty = harness({
      load: async () => {
        throw new Error('   ');
      },
    });
    await empty.core.handle({ type: 'load' });
    should(empty.replies).eql([
      { type: 'failed', id: null, code: 'load-failed', message: 'The on-device speech model could not be loaded.' },
    ]);

    const nonError = harness({
      load: async () => {
        throw 'plain string';
      },
    });
    await nonError.core.handle({ type: 'load' });
    should(nonError.replies[0]).have.property('message', 'The on-device speech model could not be loaded.');

    const nothing = harness({
      load: async () => {
        throw null;
      },
    });
    await nothing.core.handle({ type: 'load' });
    should(nothing.replies[0]).have.property('code', 'load-failed');
  });

  it('answers a failed transcribe with transcribe-failed', async () => {
    const h = harness({
      model: {
        transcribe: async () => {
          throw new Error('decode broke');
        },
      },
    });
    await h.core.handle({ type: 'transcribe', id: 9, samples: samples() });
    should(h.replies).eql([{ type: 'failed', id: 9, code: 'transcribe-failed', message: 'decode broke' }]);
  });

  it('uses a fallback message when a transcribe failure carries none', async () => {
    const h = harness({
      model: {
        transcribe: async () => {
          throw 'nope';
        },
      },
    });
    await h.core.handle({ type: 'transcribe', id: 2, samples: samples() });
    should(h.replies).eql([
      {
        type: 'failed',
        id: 2,
        code: 'transcribe-failed',
        message: 'The on-device speech model could not transcribe that.',
      },
    ]);
  });

  it('handles messages strictly in arrival order', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const h = harness({
      model: {
        transcribe: async s => {
          const tag = `t${s.length}`;
          order.push(`start ${tag}`);
          if (s.length === 1) await new Promise<void>(resolve => (releaseFirst = resolve));
          order.push(`end ${tag}`);
          return tag;
        },
      },
    });
    const first = h.core.handle({ type: 'transcribe', id: 1, samples: new Float32Array(1) });
    const second = h.core.handle({ type: 'transcribe', id: 2, samples: new Float32Array(2) });
    await new Promise(resolve => setTimeout(resolve, 5));
    should(order).eql(['start t1']);
    releaseFirst();
    await Promise.all([first, second]);
    should(order).eql(['start t1', 'end t1', 'start t2', 'end t2']);
    should(h.replies).eql([
      { type: 'result', id: 1, text: 't1' },
      { type: 'result', id: 2, text: 't2' },
    ]);
  });
});
