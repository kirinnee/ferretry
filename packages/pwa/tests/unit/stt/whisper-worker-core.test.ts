/**
 * Proves what the Whisper worker does with each message, with transformers.js replaced by a fake
 * runtime: it loads once from the verified bytes, tries WebGPU first and falls back to WebAssembly for
 * good when WebGPU fails, says which backend answered, never remembers a failed load, answers in
 * arrival order, and ignores anything that is not a request for a Whisper model.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseWhisperRequest,
  type WhisperBackend,
  type WhisperLoadedModel,
  WhisperWorkerCore,
  type WhisperWorkerReply,
} from '../../../src/lib/stt/whisper-worker-core.ts';

const TINY = 'whisper-tiny-en';
const BASE = 'whisper-base-en';
const samples = (): Float32Array => new Float32Array([0.1, 0.2]);

interface Bytes {
  readonly model: string;
}

interface Plan {
  /** Backends whose load rejects, with this error. */
  readonly loadFails?: Partial<Record<WhisperBackend, unknown>>;
  /** Backends whose decode rejects, with this error. */
  readonly decodeFails?: Partial<Record<WhisperBackend, unknown>>;
  readonly readFails?: unknown;
  readonly gpu?: boolean | 'throws';
  readonly text?: string;
}

const harness = (plan: Plan = {}) => {
  const replies: WhisperWorkerReply[] = [];
  const loads: string[] = [];
  const disposed: string[] = [];
  const warnings: string[] = [];
  let reads = 0;
  let gpuAsks = 0;
  const core = new WhisperWorkerCore<Bytes>({
    read: async model => {
      reads += 1;
      if (plan.readFails !== undefined) throw plan.readFails;
      return { model };
    },
    gpu: async () => {
      gpuAsks += 1;
      if (plan.gpu === 'throws') throw new Error('no adapter API');
      return plan.gpu ?? false;
    },
    runtime: {
      load: async (model, bytes, backend): Promise<WhisperLoadedModel> => {
        should(bytes.model).equal(model);
        loads.push(`${model}@${backend}`);
        const failure = plan.loadFails?.[backend];
        if (failure !== undefined) throw failure;
        return {
          transcribe: async () => {
            const decodeFailure = plan.decodeFails?.[backend];
            if (decodeFailure !== undefined) throw decodeFailure;
            return plan.text ?? `  heard by ${model}  `;
          },
          dispose: async () => {
            disposed.push(`${model}@${backend}`);
            if (backend === 'webgpu') throw new Error('already lost');
          },
        };
      },
    },
    post: reply => replies.push(reply),
    warn: message => warnings.push(message),
  });
  return {
    core,
    replies,
    loads,
    disposed,
    warnings,
    reads: () => reads,
    gpuAsks: () => gpuAsks,
  };
};

describe('parseWhisperRequest', () => {
  it('accepts a load or a transcribe for a Whisper model, and nothing else', () => {
    should(parseWhisperRequest({ type: 'load', model: TINY })).eql({ type: 'load', model: TINY });
    const audio = samples();
    should(parseWhisperRequest({ type: 'transcribe', id: 3, model: BASE, samples: audio })).eql({
      type: 'transcribe',
      id: 3,
      model: BASE,
      samples: audio,
    });
    for (const data of [
      null,
      'load',
      { type: 'load' },
      { type: 'load', model: 'parakeet' },
      { type: 'load', model: 'whisper-huge' },
      { type: 'transcribe', id: 1.5, model: TINY, samples: audio },
      { type: 'transcribe', id: 1, model: TINY, samples: [0.1] },
      { type: 'reset', model: TINY },
    ])
      should(parseWhisperRequest(data)).be.null();
  });
});

describe('WhisperWorkerCore', () => {
  it('loads once on WebAssembly when there is no GPU, and says so in every answer', async () => {
    const run = harness();
    await run.core.handle({ type: 'load', model: TINY });
    await run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    await run.core.handle({ type: 'transcribe', id: 2, model: TINY, samples: samples() });
    should(run.replies).eql([
      { type: 'ready', backend: 'wasm' },
      { type: 'result', id: 1, text: `heard by ${TINY}`, backend: 'wasm' },
      { type: 'result', id: 2, text: `heard by ${TINY}`, backend: 'wasm' },
    ]);
    should(run.loads).eql([`${TINY}@wasm`]);
    should(run.reads()).equal(1);
    should(run.gpuAsks()).equal(1);
  });

  it('builds on WebGPU when the worker can reach an adapter', async () => {
    const run = harness({ gpu: true });
    await run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    should(run.replies).eql([{ type: 'result', id: 1, text: `heard by ${TINY}`, backend: 'webgpu' }]);
    should(run.loads).eql([`${TINY}@webgpu`]);
  });

  it('builds again on WebAssembly when WebGPU will not load, and never tries WebGPU again', async () => {
    const run = harness({ gpu: true, loadFails: { webgpu: new Error('no shader-f16') } });
    await run.core.handle({ type: 'load', model: TINY });
    await run.core.handle({ type: 'load', model: BASE });
    should(run.replies).eql([
      { type: 'ready', backend: 'wasm' },
      { type: 'ready', backend: 'wasm' },
    ]);
    should(run.loads).eql([`${TINY}@webgpu`, `${TINY}@wasm`, `${BASE}@wasm`]);
    should(run.warnings).eql(['WebGPU could not load the model; using WebAssembly (no shader-f16)']);
  });

  it('drops a model whose WebGPU decode failed, so the next one loads on WebAssembly', async () => {
    const run = harness({ gpu: true, decodeFails: { webgpu: new Error('device lost') } });
    await run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    await run.core.handle({ type: 'transcribe', id: 2, model: TINY, samples: samples() });
    should(run.replies).eql([
      { type: 'failed', id: 1, code: 'transcribe-failed', message: 'device lost' },
      { type: 'result', id: 2, text: `heard by ${TINY}`, backend: 'wasm' },
    ]);
    should(run.loads).eql([`${TINY}@webgpu`, `${TINY}@wasm`]);
    // Disposing a lost GPU model may itself fail; that is swallowed.
    should(run.disposed).eql([`${TINY}@webgpu`]);
    should(run.warnings).eql(['WebGPU failed a decode; WebAssembly from now on (device lost)']);
  });

  it('keeps a WebAssembly model whose decode failed, and reports the failure in plain words', async () => {
    const run = harness({ decodeFails: { wasm: 'not an error' } });
    await run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    await run.core.handle({ type: 'load', model: TINY });
    should(run.replies).eql([
      {
        type: 'failed',
        id: 1,
        code: 'transcribe-failed',
        message: 'The on-device speech model could not transcribe that.',
      },
      { type: 'ready', backend: 'wasm' },
    ]);
    should(run.loads).eql([`${TINY}@wasm`]);
  });

  it('treats a GPU probe that throws as no GPU', async () => {
    const run = harness({ gpu: 'throws' });
    await run.core.handle({ type: 'load', model: TINY });
    should(run.replies).eql([{ type: 'ready', backend: 'wasm' }]);
  });

  it('swaps models when asked for another, disposing the one it held', async () => {
    const run = harness();
    await run.core.handle({ type: 'load', model: TINY });
    await run.core.handle({ type: 'load', model: BASE });
    should(run.loads).eql([`${TINY}@wasm`, `${BASE}@wasm`]);
    should(run.disposed).eql([`${TINY}@wasm`]);
  });

  it('names an install problem by its code, and retries a failed load next time', async () => {
    const missing = Object.assign(new Error('Whisper tiny is not installed on this device.'), {
      code: 'not-installed',
    });
    const run = harness({ readFails: missing });
    await run.core.handle({ type: 'load', model: TINY });
    await run.core.handle({ type: 'transcribe', id: 4, model: TINY, samples: samples() });
    should(run.replies).eql([
      { type: 'failed', id: null, code: 'not-installed', message: 'Whisper tiny is not installed on this device.' },
      { type: 'failed', id: 4, code: 'not-installed', message: 'Whisper tiny is not installed on this device.' },
    ]);
    should(run.reads()).equal(2);

    const changed = harness({ readFails: Object.assign(new Error('Encoder changed.'), { code: 'integrity' }) });
    await changed.core.handle({ type: 'load', model: TINY });
    should(changed.replies).eql([{ type: 'failed', id: null, code: 'integrity', message: 'Encoder changed.' }]);
  });

  it('reports any other load failure as load-failed, with a sentence when the error has none', async () => {
    const run = harness({ loadFails: { wasm: new Error('   ') } });
    await run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    should(run.replies).eql([
      {
        type: 'failed',
        id: 1,
        code: 'load-failed',
        message: 'The on-device speech model could not be loaded.',
      },
    ]);
  });

  it('answers in arrival order and ignores what it cannot parse', async () => {
    const run = harness({ text: 'ok' });
    const first = run.core.handle({ type: 'transcribe', id: 1, model: TINY, samples: samples() });
    const ignored = run.core.handle({ type: 'transcribe', id: 'x', model: TINY });
    const second = run.core.handle({ type: 'transcribe', id: 2, model: TINY, samples: samples() });
    await Promise.all([first, ignored, second]);
    should(run.replies.map(reply => (reply.type === 'result' ? reply.id : -1))).eql([1, 2]);
  });

  it('runs without a warning sink', async () => {
    const replies: WhisperWorkerReply[] = [];
    const core = new WhisperWorkerCore<Bytes>({
      read: async model => ({ model }),
      gpu: async () => true,
      runtime: {
        load: async (_model, _bytes, backend) => {
          if (backend === 'webgpu') throw new Error('no');
          return {
            transcribe: async () => (backend === 'wasm' ? 'fine' : ''),
            dispose: async () => undefined,
          };
        },
      },
      post: reply => replies.push(reply),
    });
    await core.handle({ type: 'load', model: TINY });
    should(replies).eql([{ type: 'ready', backend: 'wasm' }]);
  });
});
