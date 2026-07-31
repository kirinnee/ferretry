import type { SttWorkerModel, SttWorkerResponse } from '@ferretry/protocol';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSttWorkerSpawner,
  defaultWorkerEntry,
  RECOGNIZER_MODULE_VARIABLE,
  SherpaRecognizerFactory,
  type SpawnSttWorkerOptions,
  type SttRecognizer,
  type SttRecognizerFactory,
  type SttWorkerChannel,
  SttWorkerClient,
  type SttWorkerHandle,
  SttWorkerRuntime,
  type SttWorkerSpawner,
} from '../../../src/adapters/index.ts';
import { recognizerModuleFrom } from '../../../src/adapters/stt/sherpa-recognizer.ts';
import type { SttError } from '../../../src/lib/index.ts';
import { HANG_VARIABLE, OfflineRecognizer } from './fixtures/fake-recognizer.ts';

const FIXTURE_MODULE = join(import.meta.dir, 'fixtures', 'fake-recognizer.ts');

let home: string;
let model: SttWorkerModel;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-stt-worker-'));
  const directory = join(home, 'models', 'fixture');
  await Bun.$`mkdir -p ${directory}`.quiet();
  const artifacts = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
  for (const name of artifacts) await writeFile(join(directory, name), name);
  model = {
    id: 'fixture',
    directory,
    encoder: join(directory, 'encoder.int8.onnx'),
    decoder: join(directory, 'decoder.int8.onnx'),
    joiner: join(directory, 'joiner.int8.onnx'),
    tokens: join(directory, 'tokens.txt'),
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Drives the runtime in-process, with the same message discipline as the child. */
class LoopbackChannel implements SttWorkerChannel {
  readonly sent: SttWorkerResponse[] = [];
  disconnected = false;
  /** Makes exactly one send fail, the way a closing pipe would. */
  failNextSend = false;
  private handler: ((message: unknown) => void) | undefined;

  send(message: SttWorkerResponse): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('the channel closed mid-reply');
    }
    this.sent.push(message);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  deliver(message: unknown): void {
    this.handler?.(message);
  }

  last(): SttWorkerResponse | undefined {
    return this.sent.at(-1);
  }
}

class CountingRecognizer implements SttRecognizer {
  calls = 0;

  constructor(private readonly text: string | Error = 'hello world') {}

  transcribe(samples: Float32Array, sampleRate: number): string {
    this.calls += 1;
    if (this.text instanceof Error) throw this.text;
    return `${this.text} (${samples.length}@${sampleRate})`;
  }
}

class StubFactory implements SttRecognizerFactory {
  created = 0;

  constructor(private readonly outcome: SttRecognizer | Error = new CountingRecognizer()) {}

  async create(): Promise<SttRecognizer> {
    this.created += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

function runtime(factory: SttRecognizerFactory, onShutdown = () => {}) {
  const channel = new LoopbackChannel();
  let ticks = 0;
  const subject = new SttWorkerRuntime(channel, factory, { monotonicMs: () => (ticks += 5) }, onShutdown);
  subject.start();
  return { channel, subject };
}

describe('worker runtime', () => {
  it('should load a model once and answer a transcription with its text', async () => {
    // Arrange
    const recognizer = new CountingRecognizer();
    const factory = new StubFactory(recognizer);
    const { channel, subject } = runtime(factory);

    // Act
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 2 });
    await subject.drain();
    channel.deliver({ type: 'load', requestId: 'l2', model, threads: 2 });
    await subject.drain();
    channel.deliver({ type: 'transcribe', requestId: 't1', sampleRate: 16_000, audio: new Float32Array(1_600) });
    await subject.drain();

    // Assert
    should(channel.sent[0]).containDeep({ type: 'ready', requestId: 'l1', modelId: 'fixture' });
    should(channel.sent[1]).deepEqual({ type: 'ready', requestId: 'l2', modelId: 'fixture', loadMs: 0 });
    should(factory.created).equal(1);
    should(channel.sent[2]).containDeep({
      type: 'result',
      requestId: 't1',
      modelId: 'fixture',
      text: 'hello world (1600@16000)',
      audioMs: 100,
    });
    should(recognizer.calls).equal(1);
  });

  it('should reload when the model changes', async () => {
    // Arrange
    const factory = new StubFactory();
    const { channel, subject } = runtime(factory);

    // Act
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 2 });
    await subject.drain();
    channel.deliver({ type: 'load', requestId: 'l2', model: { ...model, id: 'other' }, threads: 2 });
    await subject.drain();

    // Assert
    should(factory.created).equal(2);
    should(channel.last()).containDeep({ type: 'ready', modelId: 'other' });
  });

  it('should answer a shutdown, disconnect, and stop replying', async () => {
    // Arrange
    let stopped = 0;
    const { channel, subject } = runtime(new StubFactory(), () => {
      stopped += 1;
    });

    // Act
    channel.deliver({ type: 'shutdown' });
    await subject.drain();
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 2 });
    await subject.drain();

    // Assert
    should(channel.sent).deepEqual([{ type: 'bye' }]);
    should(channel.disconnected).be.true();
    should(stopped).equal(1);
  });

  it('should refuse a request it cannot serve, with the code that explains why', async () => {
    // Arrange
    const { channel, subject } = runtime(new StubFactory(new Error('ENOENT: no such file')));

    // Act
    const answers: SttWorkerResponse[] = [];
    channel.deliver({ type: 'transcribe', requestId: 't1', sampleRate: 16_000, audio: new Float32Array(10) });
    await subject.drain();
    answers.push(channel.sent[0] as SttWorkerResponse);
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 99 });
    await subject.drain();
    answers.push(channel.sent[1] as SttWorkerResponse);
    channel.deliver({ type: 'load', requestId: 'l2', model, threads: 2 });
    await subject.drain();
    answers.push(channel.sent[2] as SttWorkerResponse);
    channel.deliver({ type: 'nonsense', requestId: 'x1' });
    await subject.drain();
    answers.push(channel.sent[3] as SttWorkerResponse);

    // Assert
    should(answers.map(answer => (answer.type === 'error' ? answer.code : answer.type))).deepEqual([
      'model_missing',
      'bad_request',
      'model_missing',
      'bad_request',
    ]);
    should(answers[3]).containDeep({ requestId: 'x1' });
  });

  it('should refuse audio the recognizer would choke on, and report a decode failure', async () => {
    // Arrange
    const failing = new CountingRecognizer(new Error('decoder exploded'));
    const { channel, subject } = runtime(new StubFactory(failing));
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 2 });
    await subject.drain();

    // Act
    channel.deliver({ type: 'transcribe', requestId: 't1', sampleRate: 16_000, audio: new Float32Array(0) });
    await subject.drain();
    const empty = channel.last();
    channel.deliver({
      type: 'transcribe',
      requestId: 't2',
      sampleRate: 16_000,
      audio: new Float32Array([Number.NaN]),
    });
    await subject.drain();
    const nonFinite = channel.last();
    channel.deliver({ type: 'transcribe', requestId: 't3', sampleRate: 16_000, audio: new Float32Array(10) });
    await subject.drain();
    const failure = channel.last();

    // Assert
    should(empty).containDeep({ type: 'error', code: 'bad_audio', message: 'audio is empty' });
    should(nonFinite).containDeep({ type: 'error', code: 'bad_audio' });
    should(failure).containDeep({ type: 'error', code: 'decode_failed', message: 'decoder exploded' });
  });

  it('should answer instead of escaping when a reply itself fails', async () => {
    // Arrange
    const { channel, subject } = runtime(new StubFactory());
    channel.failNextSend = true;

    // Act — the first reply throws, so the loop must catch it and answer anyway
    channel.deliver({ type: 'nonsense', requestId: 'x1' });
    await subject.drain();

    // Assert
    should(channel.last()).containDeep({
      type: 'error',
      code: 'decode_failed',
      message: 'the channel closed mid-reply',
    });
  });

  it('should answer rather than throw when a handler fails unexpectedly', async () => {
    // Arrange — a factory whose rejection is not an Error at all
    const { channel, subject } = runtime({
      create: () => Promise.reject('not an error object'),
    });

    // Act
    channel.deliver({ type: 'load', requestId: 'l1', model, threads: 2 });
    await subject.drain();

    // Assert
    should(channel.last()).containDeep({ type: 'error', message: 'not an error object' });
  });
});

describe('sherpa recognizer factory', () => {
  it('should build a recognizer from a module that exports OfflineRecognizer', async () => {
    // Arrange
    const factory = new SherpaRecognizerFactory('fake', async () => ({ OfflineRecognizer }));

    // Act
    const recognizer = await factory.create(model, 2);
    const actual = recognizer.transcribe(new Float32Array(320), 16_000);

    // Assert
    should(actual).equal('decoded 320 samples at 16000');
  });

  it('should accept a module that puts the export behind a default', async () => {
    // Arrange
    const factory = new SherpaRecognizerFactory('fake', async () => ({ default: { OfflineRecognizer } }));

    // Act
    const recognizer = await factory.create(model, 1);

    // Assert
    should(recognizer.transcribe(new Float32Array(16), 16_000)).equal('decoded 16 samples at 16000');
  });

  it('should refuse a module without the expected export and a model that is not there', async () => {
    // Arrange
    const wrongModule = new SherpaRecognizerFactory('fake', async () => ({}));
    const missingModel = new SherpaRecognizerFactory('fake', async () => ({ OfflineRecognizer }));
    const symlinked = join(home, 'models', 'fixture', 'link.onnx');
    await symlink(model.encoder, symlinked);

    // Act
    const actual = {
      wrongModule: await wrongModule.create(model, 1).catch((error: Error) => error.message),
      missing: await missingModel
        .create({ ...model, tokens: join(home, 'gone.txt') }, 1)
        .catch((error: Error) => error.message),
      symlink: await missingModel.create({ ...model, encoder: symlinked }, 1).catch((error: Error) => error.message),
    };

    // Assert
    should(actual.wrongModule).equal('fake does not export OfflineRecognizer');
    should(actual.missing).match(/model file is not a regular file/u);
    should(actual.symlink).match(/model file is not a regular file/u);
  });

  it('should default the module specifier and honour the configured one', () => {
    // Assert
    should(recognizerModuleFrom({})).equal('sherpa-onnx-node');
    should(recognizerModuleFrom({ [RECOGNIZER_MODULE_VARIABLE]: '  ' })).equal('sherpa-onnx-node');
    should(recognizerModuleFrom({ [RECOGNIZER_MODULE_VARIABLE]: './custom.ts' })).equal('./custom.ts');
    should(defaultWorkerEntry().endsWith('/bin/stt-worker.ts')).be.true();
  });
});

/** A spawner that never starts a process, so supervision can be driven exactly. */
class FakeSpawner implements SttWorkerSpawner {
  readonly children: {
    handlers: SpawnSttWorkerOptions;
    sent: unknown[];
    terminated: number;
    killed: number;
    alive: boolean;
  }[] = [];

  constructor(private readonly behaviour: (index: number, message: unknown, index2: number) => void = () => {}) {}

  spawn(handlers: SpawnSttWorkerOptions): SttWorkerHandle {
    const index = this.children.length;
    const child = { handlers, sent: [] as unknown[], terminated: 0, killed: 0, alive: true };
    this.children.push(child);
    return {
      pid: 1_000 + index,
      send: message => {
        child.sent.push(message);
        this.behaviour(index, message, child.sent.length - 1);
      },
      terminate: () => {
        child.terminated += 1;
      },
      kill: () => {
        child.killed += 1;
        child.alive = false;
      },
    };
  }

  exit(index: number, code: number | null, signal: string | number | null): void {
    const child = this.children[index];
    if (child === undefined) return;
    child.alive = false;
    child.handlers.onExit(code, signal);
  }
}

const clock = { nowIso: () => '2026-07-31T00:00:00.000Z' };

/** Only ever asked about processes this test spawned. */
function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settled(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await Bun.sleep(20);
}

function client(spawner: SttWorkerSpawner, overrides: Record<string, unknown> = {}) {
  return new SttWorkerClient({
    model: async () => model,
    spawner,
    clock,
    loadTimeoutMs: 50,
    decodeTimeoutMs: 50,
    shutdownTimeoutMs: 20,
    killTimeoutMs: 20,
    ...overrides,
  });
}

async function failureOf(act: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await act();
  } catch (error) {
    const failure = error as SttError;
    return { code: failure.code, message: failure.message };
  }
  throw new Error('expected the call to fail');
}

/** A spawner whose children answer a load, and optionally a transcription. */
function readySpawner(onTranscribe?: (handlers: SpawnSttWorkerOptions, requestId: string) => void): FakeSpawner {
  const spawner: FakeSpawner = new FakeSpawner((index, message) => {
    const request = message as { type: string; requestId: string };
    const handlers = spawner.children[index]?.handlers;
    if (handlers === undefined) return;
    if (request.type === 'load') {
      handlers.onMessage({ type: 'ready', requestId: request.requestId, modelId: model.id, loadMs: 12 });
      return;
    }
    onTranscribe?.(handlers, request.requestId);
  });
  return spawner;
}

/** Resolves once the supervisor has actually spawned its child. */
async function spawned(spawner: FakeSpawner): Promise<void> {
  for (let attempt = 0; attempt < 100 && spawner.children.length === 0; attempt++) await Bun.sleep(5);
}

describe('worker supervisor', () => {
  it('should spawn, load once, and transcribe through the supervisor', async () => {
    // Arrange
    const spawner = readySpawner((handlers, requestId) => {
      handlers.onMessage({
        type: 'result',
        requestId,
        modelId: model.id,
        text: 'hello world',
        audioMs: 100,
        decodeMs: 20,
      });
    });
    const subject = client(spawner);

    // Act
    const cold = subject.status();
    const ready = await subject.ensureReady();
    const again = await subject.ensureReady();
    const transcription = await subject.transcribe(new Float32Array(1_600));

    // Assert
    should(cold).deepEqual({ phase: 'cold' });
    should(ready).deepEqual({ modelId: 'fixture', loadMs: 12 });
    should(again.loadMs).equal(0);
    should(spawner.children).have.length(1);
    should(transcription).deepEqual({ text: 'hello world', modelId: 'fixture', audioMs: 100, decodeMs: 20 });
    should(subject.status()).containDeep({ phase: 'ready', modelId: 'fixture' });
    await subject.close();
  });

  it('should refuse a second transcription while one is in flight', async () => {
    // Arrange
    const spawner = readySpawner();
    const subject = client(spawner, { decodeTimeoutMs: 5_000 });
    await subject.ensureReady();

    // Act — nothing answers the first transcription, so it stays in flight
    const first = subject.transcribe(new Float32Array(160));
    const firstOutcome = failureOf(() => first);
    for (let attempt = 0; attempt < 100 && (spawner.children[0]?.sent.length ?? 0) < 2; attempt++) {
      await Bun.sleep(5);
    }
    const second = await failureOf(() => subject.transcribe(new Float32Array(160)));
    const busyWhileInFlight = subject.status().phase;
    await subject.close();

    // Assert
    should(second).deepEqual({ code: 'busy', message: 'the batch transcriber is busy' });
    should(busyWhileInFlight).equal('busy');
    should(await firstOutcome).containDeep({ code: 'service_closed' });
  });

  it('should reap the child and report a timeout when a load never answers', async () => {
    // Arrange
    const spawner = new FakeSpawner();
    const subject = client(spawner);

    // Act
    const actual = await failureOf(() => subject.ensureReady());

    // Assert
    should(actual).deepEqual({ code: 'worker_unavailable', message: 'loading the batch model timed out' });
    should(spawner.children[0]?.killed).be.aboveOrEqual(1);
    should(spawner.children[0]?.alive).be.false();
    should(subject.status().phase).equal('error');
  });

  it('should reap the child and report a timeout when a decode never answers', async () => {
    // Arrange
    const ready = readySpawner();
    const subject = client(ready);
    await subject.ensureReady();

    // Act
    const actual = await failureOf(() => subject.transcribe(new Float32Array(160)));

    // Assert
    should(actual).deepEqual({ code: 'worker_unavailable', message: 'the batch transcription timed out' });
    should(ready.children[0]?.killed).be.aboveOrEqual(1);
    should(subject.status().phase).equal('error');
  });

  it('should fail the pending request when the child crashes, and describe how', async () => {
    // Arrange
    const spawner = new FakeSpawner();
    const subject = client(spawner, { loadTimeoutMs: 5_000, onStderr: () => {} });

    // Act
    const pending = subject.ensureReady();
    await spawned(spawner);
    spawner.children[0]?.handlers.onStderr('libstdc++.so.6: cannot open shared object file\n');
    spawner.exit(0, 1, null);
    const actual = await failureOf(() => pending);

    // Assert
    should(actual.code).equal('worker_crashed');
    should(actual.message).match(/exit code 1.*libstdc/u);
    should(subject.status()).containDeep({ phase: 'error' });
  });

  it('should surface a worker error reply as its own code', async () => {
    // Arrange
    const spawner: FakeSpawner = new FakeSpawner((index, message) => {
      const request = message as { requestId: string };
      spawner.children[index]?.handlers.onMessage({
        type: 'error',
        requestId: request.requestId,
        code: 'native_missing',
        message: 'the native runtime is not installed',
      });
    });
    const subject = client(spawner);

    // Act
    const actual = await failureOf(() => subject.ensureReady());

    // Assert
    should(actual).deepEqual({ code: 'native_missing', message: 'the native runtime is not installed' });
  });

  it('should ignore replies that belong to another request, generation, or shape', async () => {
    // Arrange
    const spawner: FakeSpawner = new FakeSpawner((index, message) => {
      const request = message as { type: string; requestId: string };
      const handlers = spawner.children[index]?.handlers;
      handlers?.onMessage({ type: 'bye' });
      handlers?.onMessage('not a response at all');
      handlers?.onMessage({ type: 'ready', requestId: 'someone-else', modelId: 'x', loadMs: 1 });
      handlers?.onMessage({ type: 'error', requestId: 'someone-else', code: 'bad_audio', message: 'not yours' });
      handlers?.onMessage({
        type: 'result',
        requestId: request.requestId,
        modelId: 'x',
        text: 'wrong kind',
        audioMs: 1,
        decodeMs: 1,
      });
      handlers?.onMessage({ type: 'ready', requestId: request.requestId, modelId: model.id, loadMs: 3 });
    });
    const subject = client(spawner);

    // Act
    const actual = await subject.ensureReady();

    // Assert
    should(actual).deepEqual({ modelId: 'fixture', loadMs: 3 });
    await subject.close();
  });

  it('should refuse everything once closed, and stay safe when closed twice', async () => {
    // Arrange
    const live = readySpawner();
    const subject = client(live);
    await subject.ensureReady();

    // Act — the child never reports an exit, so the supervisor must give up waiting
    await subject.close();
    await subject.close();

    // Assert
    should(live.children[0]?.terminated).equal(1);
    should(live.children[0]?.killed).be.aboveOrEqual(1);
    should(subject.status()).deepEqual({ phase: 'closed' });
    should(await failureOf(() => subject.ensureReady())).containDeep({ code: 'service_closed' });
    should(await failureOf(() => subject.transcribe(new Float32Array(16)))).containDeep({ code: 'service_closed' });
  });

  it('should stop cleanly when the child does exit on request', async () => {
    // Arrange
    const spawner = readySpawner();
    const subject = client(spawner);
    await subject.ensureReady();

    // Act
    const closing = subject.close();
    spawner.exit(0, 0, null);
    await closing;

    // Assert
    should(spawner.children[0]?.terminated).equal(1);
    should(subject.status()).deepEqual({ phase: 'closed' });
  });

  it('should report a model that is not installed instead of spawning anything', async () => {
    // Arrange
    const spawner = new FakeSpawner();
    const subject = client(spawner, { model: async () => undefined });

    // Act
    const actual = await failureOf(() => subject.ensureReady());

    // Assert
    should(actual).deepEqual({ code: 'model_missing', message: 'the daemon model is not installed' });
    should(spawner.children).be.empty();
    await subject.close();
  });

  it('should fail the caller when the child cannot be written to', async () => {
    // Arrange
    const spawner: SttWorkerSpawner = {
      spawn: () => ({
        pid: 42,
        send: () => {
          throw new Error('channel closed');
        },
        terminate: () => {},
        kill: () => {},
      }),
    };
    const subject = client(spawner);

    // Act
    const actual = await failureOf(() => subject.ensureReady());

    // Assert
    should(actual).deepEqual({
      code: 'worker_unavailable',
      message: 'the batch transcriber could not be reached',
    });
  });

  it('should share one load between concurrent callers', async () => {
    // Arrange
    const spawner: FakeSpawner = new FakeSpawner((index, message) => {
      const request = message as { type: string; requestId: string };
      setTimeout(() => {
        spawner.children[index]?.handlers.onMessage({
          type: 'ready',
          requestId: request.requestId,
          modelId: model.id,
          loadMs: 7,
        });
      }, 5);
    });
    const subject = client(spawner, { loadTimeoutMs: 1_000 });

    // Act
    const [first, second] = await Promise.all([subject.ensureReady(), subject.ensureReady()]);

    // Assert
    should(first).deepEqual({ modelId: 'fixture', loadMs: 7 });
    should(second).deepEqual({ modelId: 'fixture', loadMs: 7 });
    should(spawner.children).have.length(1);
    await subject.close();
  });
});

describe('worker child process', () => {
  it('should load and transcribe through a real spawned worker, then exit', async () => {
    // Arrange — the real entry, the real IPC, a stand-in recognizer
    const subject = new SttWorkerClient({
      model: async () => model,
      spawner: new BunSttWorkerSpawner({ environment: { [RECOGNIZER_MODULE_VARIABLE]: FIXTURE_MODULE } }),
      clock,
      loadTimeoutMs: 20_000,
      decodeTimeoutMs: 20_000,
      shutdownTimeoutMs: 2_000,
    });

    // Act
    const ready = await subject.ensureReady();
    const actual = await subject.transcribe(new Float32Array(1_600));
    const status = subject.status();
    await subject.close();

    // Assert
    should(ready.modelId).equal('fixture');
    should(actual.text).equal('decoded 1600 samples at 16000');
    should(actual.audioMs).equal(100);
    should(status).containDeep({ phase: 'ready', modelId: 'fixture' });
    should(status.phase === 'ready' && status.pid).be.above(0);
    should(subject.status()).deepEqual({ phase: 'closed' });
  }, 30_000);

  it('should report a missing native runtime instead of hanging or crashing', async () => {
    // Arrange
    const subject = new SttWorkerClient({
      model: async () => model,
      spawner: new BunSttWorkerSpawner({
        environment: { [RECOGNIZER_MODULE_VARIABLE]: 'sherpa-onnx-node-does-not-exist' },
      }),
      clock,
      loadTimeoutMs: 20_000,
    });

    // Act
    const actual = await failureOf(() => subject.ensureReady());
    await subject.close();

    // Assert
    should(actual.code).equal('native_missing');
  }, 30_000);

  it('should leave no live process behind after a close', async () => {
    // Arrange
    const subject = new SttWorkerClient({
      model: async () => model,
      spawner: new BunSttWorkerSpawner({ environment: { [RECOGNIZER_MODULE_VARIABLE]: FIXTURE_MODULE } }),
      clock,
      loadTimeoutMs: 20_000,
      shutdownTimeoutMs: 2_000,
    });
    await subject.ensureReady();
    const status = subject.status();
    const pid = status.phase === 'ready' ? status.pid : 0;

    // Act
    should(alive(pid)).be.true();
    await subject.close();
    await settled(pid);

    // Assert
    should(alive(pid)).be.false();
  }, 30_000);

  it('should kill an unresponsive child when a load deadline passes', async () => {
    // Arrange — the fixture never returns from its constructor, so nothing answers
    const spawner = new BunSttWorkerSpawner({
      environment: { [RECOGNIZER_MODULE_VARIABLE]: FIXTURE_MODULE, [HANG_VARIABLE]: '1' },
    });
    const pids: number[] = [];
    const subject = new SttWorkerClient({
      model: async () => model,
      spawner: {
        spawn: handlers => {
          const handle = spawner.spawn(handlers);
          if (handle.pid !== undefined) pids.push(handle.pid);
          return handle;
        },
      },
      clock,
      loadTimeoutMs: 750,
    });

    // Act
    const actual = await failureOf(() => subject.ensureReady());
    const pid = pids[0] ?? 0;
    await settled(pid);

    // Assert
    should(actual).deepEqual({ code: 'worker_unavailable', message: 'loading the batch model timed out' });
    should(pid).be.above(0);
    should(alive(pid)).be.false();
    should(subject.status().phase).equal('error');
    await subject.close();
  }, 30_000);
});
