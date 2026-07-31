import type { SttEnhancementResult, SttWorkerStatus } from '@ferretry/protocol';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSttCommandRunner,
  type SttEnhancerLike,
  SttModelStore,
  SttService,
  type SttTranscriberLike,
  type SttWorkerTranscription,
} from '../../../src/adapters/index.ts';
import {
  createFoundationPaths,
  createSttPaths,
  encodeCanonicalWav,
  float32ToPcm16le,
  resolveStateHome,
  SttEnhancementError,
  SttError,
  SttModelCatalog,
  type SttModelDefinition,
  type SttPaths,
} from '../../../src/lib/index.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);
const VOCAB = encode('hello\nworld\n');
const WEIGHTS = encode('fake onnx weights');
const at = '2026-07-31T00:00:00.000Z';

const browserFixture: SttModelDefinition = {
  id: 'browser-fixture',
  kind: 'browser',
  label: 'Browser fixture',
  languages: ['en'],
  costs: {
    downloadBytes: VOCAB.byteLength + WEIGHTS.byteLength,
    diskBytes: VOCAB.byteLength + WEIGHTS.byteLength,
    ramBytesApprox: 1_024,
    summary: 'a few bytes',
  },
  files: [
    {
      name: 'vocab.txt',
      bytes: VOCAB.byteLength,
      sha256: sha256(VOCAB),
      url: 'https://models.invalid/vocab.txt',
      mime: 'text/plain; charset=utf-8',
      public: true,
    },
    {
      name: 'weights.onnx',
      bytes: WEIGHTS.byteLength,
      sha256: sha256(WEIGHTS),
      url: 'https://models.invalid/weights.onnx',
      mime: 'application/octet-stream',
      public: false,
    },
  ],
};

const daemonFixture: SttModelDefinition = {
  id: 'daemon-fixture',
  kind: 'daemon',
  label: 'Daemon fixture',
  languages: ['en'],
  costs: {
    downloadBytes: VOCAB.byteLength,
    diskBytes: VOCAB.byteLength,
    ramBytesApprox: 1_024,
    summary: 'a few bytes',
  },
  files: [
    {
      name: 'encoder.int8.onnx',
      bytes: VOCAB.byteLength,
      sha256: sha256(VOCAB),
      url: 'https://models.invalid/encoder.onnx',
      mime: 'application/octet-stream',
      public: false,
    },
  ],
};

class FakeTranscriber implements SttTranscriberLike {
  closed = 0;
  received: number[] = [];

  constructor(
    private phase: SttWorkerStatus = { phase: 'ready', pid: 4_242, modelId: daemonFixture.id, loadedAt: at },
    private readonly outcome: SttWorkerTranscription | SttError = {
      text: 'hello world',
      modelId: daemonFixture.id,
      audioMs: 100,
      decodeMs: 20,
    },
  ) {}

  status(): SttWorkerStatus {
    return this.phase;
  }

  async transcribe(samples: Float32Array): Promise<SttWorkerTranscription> {
    this.received.push(samples.length);
    if (this.outcome instanceof SttError) throw this.outcome;
    return this.outcome;
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.phase = { phase: 'closed' };
  }
}

class FakeEnhancer implements SttEnhancerLike {
  readonly seen: unknown[] = [];

  constructor(private readonly outcome: SttEnhancementResult | SttEnhancementError) {}

  async enhance(input: unknown): Promise<SttEnhancementResult> {
    this.seen.push(input);
    if (this.outcome instanceof SttEnhancementError) throw this.outcome;
    return this.outcome;
  }
}

let home: string;
let paths: SttPaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-stt-service-'));
  paths = createSttPaths(createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home })));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function store(): SttModelStore {
  const served = new Map([
    ['https://models.invalid/vocab.txt', VOCAB],
    ['https://models.invalid/weights.onnx', WEIGHTS],
    ['https://models.invalid/encoder.onnx', VOCAB],
  ]);
  let tick = 0;
  return new SttModelStore({
    paths,
    catalog: new SttModelCatalog([browserFixture, daemonFixture]),
    fetch: async url => {
      const bytes = served.get(url) ?? new Uint8Array(0);
      return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
    },
    runner: new BunSttCommandRunner(),
    now: () => new Date(Date.UTC(2026, 6, 31, 0, 0, tick++)).toISOString(),
    uniqueId: () => `svc-${tick}`,
  });
}

interface Harness {
  readonly service: SttService;
  readonly models: SttModelStore;
  readonly worker: FakeTranscriber;
  readonly enhancer: FakeEnhancer;
}

function harness(overrides: { worker?: FakeTranscriber; enhancer?: FakeEnhancer } = {}): Harness {
  const models = store();
  const worker = overrides.worker ?? new FakeTranscriber();
  const enhancer =
    overrides.enhancer ??
    new FakeEnhancer({ text: 'Hello, world.', provider: 'groq', model: 'llama-3.1-8b-instant', latencyMs: 42 });
  return { service: new SttService({ models, worker, enhancer }), models, worker, enhancer };
}

const url = (path: string) => `http://daemon.invalid${path}`;
const get = (path: string, headers: Record<string, string> = {}) => new Request(url(path), { headers });
const post = (path: string, body?: string | Uint8Array, headers: Record<string, string> = {}) =>
  new Request(url(path), { method: 'POST', body, headers });

async function bodyOf(response: Response | undefined): Promise<Record<string, unknown>> {
  should(response).be.ok();
  return (await (response as Response).json()) as Record<string, unknown>;
}

describe('STT service routing', () => {
  it('should leave paths it does not own to whoever else is mounted', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const actual = await service.handle(get('/v1/sessions'));

    // Assert
    should(actual).be.undefined();
  });

  it('should report the subsystem status with its limits', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const response = await service.handle(get('/v1/stt/status'));
    const actual = await bodyOf(response);

    // Assert
    should(response?.status).equal(200);
    should(actual).containDeep({ streaming: false, mode: 'batch', language: 'en', available: false });
    should(actual.limits).containDeep({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
  });

  it('should list the catalog and one model on its own', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const list = await bodyOf(await service.handle(get('/v1/stt/models')));
    const one = await bodyOf(await service.handle(get(`/v1/stt/models/${browserFixture.id}`)));
    const unknown = await service.handle(get('/v1/stt/models/not-a-model'));

    // Assert
    should(list.models).containDeep({ daemon: { id: daemonFixture.id }, browser: { id: browserFixture.id } });
    should(one).containDeep({ id: browserFixture.id, state: 'not-installed' });
    should(unknown?.status).equal(404);
    should(await bodyOf(unknown)).containDeep({ code: 'model_not_found' });
  });

  it('should refuse a method a route does not serve', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const actual = {
      status: await service.handle(post('/v1/stt/status')),
      models: await service.handle(post('/v1/stt/models')),
      transcribe: await service.handle(get('/v1/stt/transcribe')),
      enhance: await service.handle(get('/v1/stt/enhance')),
      install: await service.handle(new Request(url('/v1/stt/models/x/install'), { method: 'DELETE' })),
      file: await service.handle(post('/stt-models/browser-fixture/vocab.txt')),
    };

    // Assert
    for (const response of Object.values(actual)) should(response?.status).equal(405);
    should(await bodyOf(actual.install)).containDeep({ code: 'method_not_allowed' });
  });
});

describe('STT service model installation', () => {
  it('should accept an install, then report it already installed', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const started = await service.handle(post(`/v1/stt/models/${browserFixture.id}/install`));
    const startedBody = await bodyOf(started);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await bodyOf(await service.handle(get(`/v1/stt/models/${browserFixture.id}/install`)));
      if (status.state === 'ready') break;
      await Bun.sleep(10);
    }
    const settled = await service.handle(post(`/v1/stt/models/${browserFixture.id}/install`));

    // Assert
    should(started?.status).equal(202);
    should(startedBody).containDeep({ state: 'installing' });
    should(settled?.status).equal(200);
    should(await bodyOf(settled)).containDeep({ state: 'ready' });
  });

  it('should refuse a second install while one is running', async () => {
    // Arrange — the install stalls until it is released
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const models = new SttModelStore({
      paths,
      catalog: new SttModelCatalog([browserFixture, daemonFixture]),
      fetch: async target => {
        await gate;
        const bytes = target.endsWith('vocab.txt') ? VOCAB : WEIGHTS;
        return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
      },
      runner: new BunSttCommandRunner(),
      now: () => at,
      uniqueId: () => 'svc-1',
    });
    const service = new SttService({
      models,
      worker: new FakeTranscriber(),
      enhancer: new FakeEnhancer({
        text: 'x',
        provider: 'groq',
        model: 'm',
        latencyMs: 1,
      }),
    });

    // Act
    const first = await service.handle(post(`/v1/stt/models/${browserFixture.id}/install`));
    const second = await service.handle(post(`/v1/stt/models/${browserFixture.id}/install`));
    release();
    await models.install(browserFixture.id);

    // Assert
    should(first?.status).equal(202);
    should(second?.status).equal(409);
    should(await bodyOf(second)).containDeep({ code: 'model_installing' });
  });
});

describe('STT service transcription', () => {
  const pcm = (samples: number) => float32ToPcm16le(new Float32Array(samples));

  it('should transcribe raw PCM once the daemon model is installed', async () => {
    // Arrange
    const { service, models, worker } = harness();
    await models.install(daemonFixture.id);

    // Act
    const response = await service.handle(
      post('/v1/stt/transcribe', pcm(1_600), { 'content-type': 'audio/L16; rate=16000; channels=1' }),
    );
    const actual = await bodyOf(response);

    // Assert
    should(response?.status).equal(200);
    should(actual).deepEqual({
      text: 'hello world',
      audioMs: 100,
      decodeMs: 20,
      rtf: 0.2,
      modelId: daemonFixture.id,
      language: 'en',
      mode: 'batch',
      streaming: false,
    });
    should(worker.received).deepEqual([1_600]);
  });

  it('should transcribe a canonical WAV body', async () => {
    // Arrange
    const { service, models } = harness();
    await models.install(daemonFixture.id);

    // Act
    const response = await service.handle(
      post('/v1/stt/transcribe', encodeCanonicalWav(new Float32Array(800)), { 'content-type': 'audio/wav' }),
    );

    // Assert
    should(response?.status).equal(200);
    should(await bodyOf(response)).containDeep({ text: 'hello world' });
  });

  it('should refuse a transcription the subsystem cannot serve', async () => {
    // Arrange
    const missing = harness();
    const busy = harness({
      worker: new FakeTranscriber({ phase: 'busy', pid: 1, modelId: daemonFixture.id, loadedAt: at }),
    });

    // Act — the model is absent for the first request and installed for the rest
    const actual = {
      noModel: await missing.service.handle(post('/v1/stt/transcribe', pcm(160), { 'content-type': 'audio/pcm' })),
      busy: undefined as Response | undefined,
      wrongType: undefined as Response | undefined,
    };
    await busy.models.install(daemonFixture.id);
    actual.busy = await busy.service.handle(post('/v1/stt/transcribe', pcm(160), { 'content-type': 'audio/pcm' }));
    actual.wrongType = await busy.service.handle(
      post('/v1/stt/transcribe', pcm(160), { 'content-type': 'audio/mpeg' }),
    );

    // Assert
    should(actual.noModel?.status).equal(409);
    should(await bodyOf(actual.noModel)).containDeep({ code: 'model_missing' });
    should(actual.busy?.status).equal(409);
    should(await bodyOf(actual.busy)).containDeep({ code: 'busy' });
    should(actual.wrongType?.status).equal(400);
  });

  it('should refuse audio that is too large, by declaration and while it streams', async () => {
    // Arrange — a one-second limit makes the boundary cheap to cross
    const { models } = harness();
    await models.install(daemonFixture.id);
    const tight = new SttService({
      models,
      worker: new FakeTranscriber(),
      enhancer: new FakeEnhancer({ text: 'x', provider: 'groq', model: 'm', latencyMs: 1 }),
      maxDurationSeconds: 1,
    });

    // Act
    const declared = await tight.handle(
      post('/v1/stt/transcribe', new Uint8Array(40_000), { 'content-type': 'audio/pcm' }),
    );
    const streamed = await tight.handle(
      new Request(url('/v1/stt/transcribe'), {
        method: 'POST',
        headers: { 'content-type': 'audio/pcm' },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(8_000));
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );

    // Assert
    should(declared?.status).equal(413);
    should(await bodyOf(declared)).containDeep({ code: 'too_long' });
    should(streamed?.status).equal(413);
  });

  it('should report a worker failure with the code the client can act on', async () => {
    // Arrange
    const { service, models } = harness({
      worker: new FakeTranscriber(
        { phase: 'ready', pid: 1, modelId: daemonFixture.id, loadedAt: at },
        new SttError('worker_crashed', 'the batch transcriber stopped (signal SIGKILL)'),
      ),
    });
    await models.install(daemonFixture.id);

    // Act
    const response = await service.handle(post('/v1/stt/transcribe', pcm(160), { 'content-type': 'audio/pcm' }));

    // Assert
    should(response?.status).equal(503);
    should(await bodyOf(response)).containDeep({ code: 'worker_crashed' });
  });

  it('should refuse a body-less transcription and malformed audio', async () => {
    // Arrange
    const { service, models } = harness();
    await models.install(daemonFixture.id);

    // Act
    const actual = {
      empty: await service.handle(post('/v1/stt/transcribe', new Uint8Array(0), { 'content-type': 'audio/pcm' })),
      odd: await service.handle(post('/v1/stt/transcribe', new Uint8Array([1, 2, 3]), { 'content-type': 'audio/pcm' })),
    };

    // Assert
    should(actual.empty?.status).equal(400);
    should(await bodyOf(actual.empty)).containDeep({ code: 'bad_audio' });
    should(actual.odd?.status).equal(400);
  });
});

describe('STT service enhancement', () => {
  it('should pass a request to the enhancer and return its result', async () => {
    // Arrange
    const { service, enhancer } = harness();

    // Act
    const response = await service.handle(
      post('/v1/stt/enhance', JSON.stringify({ text: 'helo wold', provider: 'groq' }), {
        'content-type': 'application/json',
      }),
    );

    // Assert
    should(response?.status).equal(200);
    should(await bodyOf(response)).deepEqual({
      text: 'Hello, world.',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      latencyMs: 42,
    });
    should(enhancer.seen).deepEqual([{ text: 'helo wold', provider: 'groq' }]);
  });

  it('should answer an enhancement failure with its own status', async () => {
    // Arrange
    const { service } = harness({ enhancer: new FakeEnhancer(new SttEnhancementError('rate_limited', 'slow down')) });

    // Act
    const response = await service.handle(
      post('/v1/stt/enhance', JSON.stringify({ text: 'x', provider: 'groq' }), {
        'content-type': 'application/json',
      }),
    );

    // Assert
    should(response?.status).equal(429);
    should(await bodyOf(response)).deepEqual({ error: 'slow down', code: 'rate_limited' });
  });

  it('should refuse a body that is not JSON', async () => {
    // Arrange
    const { service } = harness();

    // Act
    const response = await service.handle(post('/v1/stt/enhance', 'not json', { 'content-type': 'application/json' }));

    // Assert
    should(response?.status).equal(400);
    should(await bodyOf(response)).containDeep({ code: 'bad_request' });
  });
});

describe('STT service model files', () => {
  async function installed(): Promise<Harness> {
    const built = harness();
    await built.models.install(browserFixture.id);
    return built;
  }

  it('should serve a public browser file with caching headers', async () => {
    // Arrange
    const { service } = await installed();

    // Act
    const response = await service.handle(get(`/stt-models/${browserFixture.id}/vocab.txt`));

    // Assert
    should(response?.status).equal(200);
    should(response?.headers.get('etag')).equal(`"sha256-${sha256(VOCAB)}"`);
    should(response?.headers.get('content-type')).equal('text/plain; charset=utf-8');
    should(response?.headers.get('accept-ranges')).equal('bytes');
    should(response?.headers.get('x-content-type-options')).equal('nosniff');
    should(await (response as Response).text()).equal('hello\nworld\n');
  });

  it('should answer a conditional request with 304 and a HEAD without a body', async () => {
    // Arrange
    const { service } = await installed();
    const etag = `"sha256-${sha256(VOCAB)}"`;

    // Act
    const conditional = await service.handle(
      get(`/stt-models/${browserFixture.id}/vocab.txt`, { 'if-none-match': etag }),
    );
    const head = await service.handle(
      new Request(url(`/stt-models/${browserFixture.id}/vocab.txt`), { method: 'HEAD' }),
    );

    // Assert
    should(conditional?.status).equal(304);
    should(await (conditional as Response).text()).equal('');
    should(head?.status).equal(200);
    should(head?.headers.get('content-length')).equal(String(VOCAB.byteLength));
    should(await (head as Response).text()).equal('');
  });

  it('should serve a byte range and refuse one it cannot satisfy', async () => {
    // Arrange
    const { service } = await installed();

    // Act
    const ranged = await service.handle(get(`/stt-models/${browserFixture.id}/vocab.txt`, { range: 'bytes=0-4' }));
    const headRange = await service.handle(
      new Request(url(`/stt-models/${browserFixture.id}/vocab.txt`), {
        method: 'HEAD',
        headers: { range: 'bytes=6-' },
      }),
    );
    const unsatisfiable = await service.handle(
      get(`/stt-models/${browserFixture.id}/vocab.txt`, { range: 'bytes=500-600' }),
    );

    // Assert
    should(ranged?.status).equal(206);
    should(ranged?.headers.get('content-range')).equal(`bytes 0-4/${VOCAB.byteLength}`);
    should(await (ranged as Response).text()).equal('hello');
    should(headRange?.status).equal(206);
    should(unsatisfiable?.status).equal(416);
    should(unsatisfiable?.headers.get('content-range')).equal(`bytes */${VOCAB.byteLength}`);
  });

  it('should refuse a private file, an unknown file, and a traversal attempt', async () => {
    // Arrange
    const { service } = await installed();

    // Act
    const actual = {
      private: await service.handle(get(`/stt-models/${browserFixture.id}/weights.onnx`)),
      unknown: await service.handle(get(`/stt-models/${browserFixture.id}/passwd`)),
      traversal: await service.handle(get('/stt-models/browser-fixture/%2e%2e%2f%2e%2e%2fetc%2fpasswd')),
    };

    // Assert
    should(actual.private?.status).equal(404);
    should(actual.unknown?.status).equal(404);
    should(actual.traversal).be.undefined();
  });
});

describe('STT service shutdown', () => {
  it('should refuse every request once closed and close the worker with it', async () => {
    // Arrange
    const { service, worker } = harness();

    // Act
    await service.close();
    await service.close();
    const response = await service.handle(get('/v1/stt/status'));

    // Assert
    should(worker.closed).equal(2);
    should(response?.status).equal(503);
    should(await bodyOf(response)).containDeep({ code: 'service_closed' });
    should((await service.status()).worker).deepEqual({ phase: 'closed' });
  });
});
