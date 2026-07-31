import { STT_MAX_SAMPLES, type SttWorkerModel, SttWorkerStatusSchema } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  audioDurationMs,
  audioRefusal,
  boundedWorkerMessage,
  classifyLoadFailure,
  exitFailure,
  isValidThreadCount,
  parseWorkerRequest,
  parseWorkerResponse,
  projectWorkerStatus,
  requestIdOf,
  sameWorkerModel,
  type SttError,
  workerErrorResponse,
  workerRequestFailure,
} from '../../../src/lib/index.ts';

const at = '2026-07-31T00:00:00.000Z';
const model: SttWorkerModel = {
  id: 'parakeet',
  directory: '/models/parakeet',
  encoder: '/models/parakeet/encoder.int8.onnx',
  decoder: '/models/parakeet/decoder.int8.onnx',
  joiner: '/models/parakeet/joiner.int8.onnx',
  tokens: '/models/parakeet/tokens.txt',
};

describe('worker request parsing', () => {
  it('should accept the three request shapes the worker answers', () => {
    // Act
    const actual = {
      load: parseWorkerRequest({ type: 'load', requestId: 'r1', model, threads: 2 })?.type,
      transcribe: parseWorkerRequest({
        type: 'transcribe',
        requestId: 'r2',
        sampleRate: 16_000,
        audio: new Float32Array([0.1]),
      })?.type,
      shutdown: parseWorkerRequest({ type: 'shutdown' })?.type,
    };

    // Assert
    should(actual).deepEqual({ load: 'load', transcribe: 'transcribe', shutdown: 'shutdown' });
  });

  it('should reject anything that is not a request, keeping the id when it can', () => {
    // Act
    const actual = {
      unknownType: parseWorkerRequest({ type: 'explode', requestId: 'r9' }),
      missingModel: parseWorkerRequest({ type: 'load', requestId: 'r1', threads: 2 }),
      wrongRate: parseWorkerRequest({
        type: 'transcribe',
        requestId: 'r1',
        sampleRate: 8_000,
        audio: new Float32Array(1),
      }),
      notAudio: parseWorkerRequest({ type: 'transcribe', requestId: 'r1', sampleRate: 16_000, audio: [0.1] }),
      notAnObject: parseWorkerRequest('nope'),
      id: requestIdOf({ requestId: 'r9' }),
      noId: requestIdOf({ requestId: 42 }),
      emptyId: requestIdOf({ requestId: '' }),
      notARecord: requestIdOf('nope'),
    };

    // Assert
    should(actual.unknownType).be.undefined();
    should(actual.missingModel).be.undefined();
    should(actual.wrongRate).be.undefined();
    should(actual.notAudio).be.undefined();
    should(actual.notAnObject).be.undefined();
    should(actual.id).equal('r9');
    should(actual.noId).be.undefined();
    should(actual.emptyId).be.undefined();
    should(actual.notARecord).be.undefined();
  });

  it('should accept every response shape and reject the rest', () => {
    // Act
    const actual = {
      ready: parseWorkerResponse({ type: 'ready', requestId: 'r1', modelId: 'm', loadMs: 12 })?.type,
      result: parseWorkerResponse({
        type: 'result',
        requestId: 'r1',
        modelId: 'm',
        text: 'hi',
        audioMs: 10,
        decodeMs: 2,
      })?.type,
      failure: parseWorkerResponse({ type: 'error', code: 'decode_failed', message: 'boom' })?.type,
      bye: parseWorkerResponse({ type: 'bye' })?.type,
      unknown: parseWorkerResponse({ type: 'chatter' }),
      badCode: parseWorkerResponse({ type: 'error', code: 'busy', message: 'boom' }),
    };

    // Assert
    should(actual).deepEqual({
      ready: 'ready',
      result: 'result',
      failure: 'error',
      bye: 'bye',
      unknown: undefined,
      badCode: undefined,
    });
  });

  it('should build a worker error with and without a request id', () => {
    // Act
    const actual = {
      correlated: workerErrorResponse('bad_audio', 'audio is empty', 'r1'),
      loose: workerErrorResponse('bad_request', 'invalid STT worker message'),
    };

    // Assert
    should(actual.correlated).deepEqual({
      type: 'error',
      code: 'bad_audio',
      message: 'audio is empty',
      requestId: 'r1',
    });
    should(actual.loose).not.have.property('requestId');
    should(workerRequestFailure({ type: 'error', code: 'load_failed', message: 'no runtime' }).code).equal(
      'load_failed',
    );
  });
});

describe('worker failure classification', () => {
  it('should tell missing weights, a missing runtime, and everything else apart', () => {
    // Act
    const actual = {
      weights: classifyLoadFailure(new Error('ENOENT: no such file or directory')),
      notRegular: classifyLoadFailure(new Error('model file is not a regular file: /models/x')),
      runtime: classifyLoadFailure(new Error('Cannot find module sherpa-onnx-node')),
      library: classifyLoadFailure(new Error('libstdc++.so.6: cannot open shared object file')),
      other: classifyLoadFailure(new Error('config rejected')),
    };

    // Assert
    should(actual).deepEqual({
      weights: 'model_missing',
      notRegular: 'model_missing',
      runtime: 'native_missing',
      library: 'native_missing',
      other: 'load_failed',
    });
  });

  it('should bound a message and fall back when there is nothing to say', () => {
    // Act
    const actual = {
      long: boundedWorkerMessage(new Error('x'.repeat(2_000)), 'fallback').length,
      blank: boundedWorkerMessage(new Error('   '), 'fallback'),
      nothing: boundedWorkerMessage(undefined, 'fallback'),
      plain: boundedWorkerMessage('plain text', 'fallback'),
    };

    // Assert
    should(actual).deepEqual({ long: 1_000, blank: 'fallback', nothing: 'fallback', plain: 'plain text' });
  });

  it('should describe an exit by code, by signal, and with the stderr tail', () => {
    // Act
    const actual = {
      code: exitFailure(3, null, '', at),
      signal: exitFailure(null, 'SIGKILL', '', at),
      unknown: exitFailure(null, null, '', at),
      withTail: exitFailure(1, null, '  native runtime missing  ', at),
    };

    // Assert
    should(actual.code.message).equal('the batch transcriber stopped (exit code 3)');
    should(actual.signal.message).equal('the batch transcriber stopped (signal SIGKILL)');
    should(actual.unknown.message).equal('the batch transcriber stopped (exit code unknown)');
    should(actual.withTail.message).equal('the batch transcriber stopped (exit code 1): native runtime missing');
    should(actual.code.code).equal('worker_crashed');
    should(actual.code.at).equal(at);
  });
});

describe('worker audio guards', () => {
  it('should refuse empty, over-long, and non-finite audio', () => {
    // Act
    const actual = {
      empty: audioRefusal(new Float32Array(0)),
      long: audioRefusal(new Float32Array(STT_MAX_SAMPLES + 1)),
      nonFinite: audioRefusal(new Float32Array([0.1, Number.NaN])),
      fine: audioRefusal(new Float32Array([0.1, -0.2])),
    };

    // Assert
    should(actual.empty).deepEqual({ code: 'bad_audio', message: 'audio is empty' });
    should(actual.long).deepEqual({ code: 'too_long', message: 'audio exceeds the 120 second limit' });
    should(actual.nonFinite).deepEqual({ code: 'bad_audio', message: 'audio samples must be finite' });
    should(actual.fine).be.undefined();
  });

  it('should measure duration from the sample count and compare loaded models', () => {
    // Assert
    should(audioDurationMs(new Float32Array(16_000))).equal(1_000);
    should(isValidThreadCount(2)).be.true();
    should([isValidThreadCount(0), isValidThreadCount(33), isValidThreadCount(1.5)]).deepEqual([false, false, false]);
    should(sameWorkerModel(model, model)).be.true();
    should(sameWorkerModel(undefined, model)).be.false();
    should(sameWorkerModel({ ...model, id: 'other' }, model)).be.false();
    should(sameWorkerModel({ ...model, directory: '/elsewhere' }, model)).be.false();
  });
});

describe('worker status projection', () => {
  it('should derive every phase from the supervisor facts', () => {
    // Act
    const actual = {
      closed: projectWorkerStatus({ closed: true, loading: true, busy: true, pid: 1 }),
      failed: projectWorkerStatus({
        closed: false,
        loading: false,
        busy: false,
        pid: 7,
        modelId: 'm',
        lastError: { code: 'worker_crashed', message: 'stopped', at },
      }),
      loading: projectWorkerStatus({ closed: false, loading: true, busy: false, pid: 7 }),
      cold: projectWorkerStatus({ closed: false, loading: false, busy: false }),
      halfLoaded: projectWorkerStatus({ closed: false, loading: false, busy: false, pid: 7, modelId: 'm' }),
      ready: projectWorkerStatus({ closed: false, loading: false, busy: false, pid: 7, modelId: 'm', loadedAt: at }),
      busy: projectWorkerStatus({ closed: false, loading: false, busy: true, pid: 7, modelId: 'm', loadedAt: at }),
    };

    // Assert
    should(actual.closed).deepEqual({ phase: 'closed' });
    should(actual.failed.phase).equal('error');
    should(actual.loading).deepEqual({ phase: 'loading', pid: 7 });
    should(actual.cold).deepEqual({ phase: 'cold' });
    should(actual.halfLoaded).deepEqual({ phase: 'cold' });
    should(actual.ready).deepEqual({ phase: 'ready', pid: 7, modelId: 'm', loadedAt: at });
    should(actual.busy.phase).equal('busy');
    for (const status of Object.values(actual)) should(SttWorkerStatusSchema.safeParse(status).success).be.true();
  });

  it('should report a failure without a pid or model when neither is known', () => {
    // Act
    const actual = projectWorkerStatus({
      closed: false,
      loading: false,
      busy: false,
      lastError: { code: 'load_failed', message: 'no runtime', at },
    });

    // Assert
    should(actual).deepEqual({ phase: 'error', lastError: { code: 'load_failed', message: 'no runtime', at } });
    should(SttWorkerStatusSchema.safeParse(actual).success).be.true();
    should((workerRequestFailure({ type: 'error', code: 'bad_audio', message: 'x' }) as SttError).code).equal(
      'bad_audio',
    );
  });
});
