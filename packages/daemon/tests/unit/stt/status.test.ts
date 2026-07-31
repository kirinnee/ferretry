import { type SttModelStatus, SttStatusSchema, SttTranscriptSchema, type SttWorkerStatus } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  assertCanTranscribe,
  DAEMON_STT_MODEL_ID,
  idleInstall,
  maxRequestBytes,
  projectSttStatus,
  projectTranscript,
  SttModelCatalog,
  type SttError,
  sttLimits,
  projectModelStatus,
} from '../../../src/lib/index.ts';

const catalog = new SttModelCatalog();
const daemonModel = catalog.definition(DAEMON_STT_MODEL_ID);
const browserModel = catalog.definitionFor('browser');
const at = '2026-07-31T00:00:00.000Z';

const notInstalled = (definition = daemonModel): SttModelStatus =>
  projectModelStatus(definition, idleInstall(definition), undefined, false);

const ready = (definition = daemonModel): SttModelStatus =>
  projectModelStatus(
    definition,
    idleInstall(definition),
    { definition, directory: `/models/${definition.id}`, installedAt: at },
    false,
  );

const readyWorker: SttWorkerStatus = { phase: 'ready', pid: 4_242, modelId: daemonModel.id, loadedAt: at };

describe('STT limits', () => {
  it('should derive the byte budget from the duration limit', () => {
    // Act
    const actual = sttLimits(120);

    // Assert
    should(actual).deepEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      maxDurationSeconds: 120,
      maxPcmBytes: 120 * 16_000 * 2,
    });
    should(maxRequestBytes(actual, 'pcm16le')).equal(actual.maxPcmBytes);
    should(maxRequestBytes(actual, 'wav')).equal(actual.maxPcmBytes + 4_096);
  });

  it('should floor a fractional duration limit and refuse a non-positive one', () => {
    // Act & Assert
    should(sttLimits(1.9).maxDurationSeconds).equal(1);
    should(() => sttLimits(0)).throw(RangeError);
    should(() => sttLimits(Number.NaN)).throw(RangeError);
  });
});

describe('STT status projection', () => {
  const facts = { models: { daemon: ready(), browser: notInstalled(browserModel) }, maxDurationSeconds: 120 };

  it('should report available whenever the model is ready and the worker has not failed', () => {
    // Act
    const actual = {
      live: projectSttStatus({ ...facts, worker: readyWorker, closed: false }),
      cold: projectSttStatus({ ...facts, worker: { phase: 'cold' }, closed: false }),
      modelMissing: projectSttStatus({
        models: { daemon: notInstalled(), browser: notInstalled(browserModel) },
        maxDurationSeconds: 120,
        worker: readyWorker,
        closed: false,
      }),
      failed: projectSttStatus({
        ...facts,
        worker: { phase: 'error', lastError: { code: 'load_failed', message: 'no native runtime', at } },
        closed: false,
      }),
    };

    // Assert
    should(actual.live.available).be.true();
    should(actual.cold.available).be.true();
    should(actual.modelMissing.available).be.false();
    should(actual.failed.available).be.false();
    for (const status of Object.values(actual)) should(SttStatusSchema.safeParse(status).success).be.true();
  });

  it('should report a closed worker once the service is closing, not a stale live phase', () => {
    // Act
    const actual = projectSttStatus({ ...facts, worker: readyWorker, closed: true });

    // Assert
    should(actual.worker).deepEqual({ phase: 'closed' });
    should(actual.available).be.false();
    should(SttStatusSchema.safeParse(actual).success).be.true();
  });
});

describe('transcript projection', () => {
  it('should compute the real-time factor from the measured durations', () => {
    // Act
    const actual = projectTranscript({ text: 'hello world', modelId: daemonModel.id, audioMs: 1_000, decodeMs: 250 });

    // Assert
    should(actual.rtf).equal(0.25);
    should(actual.language).equal('en');
    should(actual.streaming).be.false();
    should(SttTranscriptSchema.safeParse(actual).success).be.true();
  });

  it('should report a zero factor rather than a division by zero or a negative duration', () => {
    // Act
    const actual = {
      silent: projectTranscript({ text: '', modelId: daemonModel.id, audioMs: 0, decodeMs: 12 }),
      negative: projectTranscript({ text: '', modelId: daemonModel.id, audioMs: -5, decodeMs: -1 }),
      infinite: projectTranscript({
        text: '',
        modelId: daemonModel.id,
        audioMs: Number.POSITIVE_INFINITY,
        decodeMs: Number.NaN,
      }),
    };

    // Assert
    should(actual.silent.rtf).equal(0);
    should(actual.negative).containDeep({ audioMs: 0, decodeMs: 0, rtf: 0 });
    should(actual.infinite).containDeep({ audioMs: 0, decodeMs: 0, rtf: 0 });
    for (const transcript of Object.values(actual)) {
      should(SttTranscriptSchema.safeParse(transcript).success).be.true();
    }
  });
});

describe('transcription admission', () => {
  const refusal = (facts: Parameters<typeof assertCanTranscribe>[0]): string => {
    try {
      assertCanTranscribe(facts);
      return 'allowed';
    } catch (error) {
      return (error as SttError).code;
    }
  };

  it('should admit a request when the model is ready and the worker is idle', () => {
    // Assert
    should(refusal({ closed: false, daemon: ready(), worker: readyWorker })).equal('allowed');
    should(refusal({ closed: false, daemon: ready(), worker: { phase: 'cold' } })).equal('allowed');
  });

  it('should refuse with the code the client can act on', () => {
    // Arrange
    const installing = projectModelStatus(
      daemonModel,
      { modelId: daemonModel.id, phase: 'downloading', receivedBytes: 1, totalBytes: 2, startedAt: at },
      undefined,
      true,
    );

    // Act
    const actual = {
      closing: refusal({ closed: true, daemon: ready(), worker: readyWorker }),
      installing: refusal({ closed: false, daemon: installing, worker: readyWorker }),
      missing: refusal({ closed: false, daemon: notInstalled(), worker: readyWorker }),
      busy: refusal({
        closed: false,
        daemon: ready(),
        worker: { phase: 'busy', pid: 4_242, modelId: daemonModel.id, loadedAt: at },
      }),
      closedWorker: refusal({ closed: false, daemon: ready(), worker: { phase: 'closed' } }),
    };

    // Assert
    should(actual).deepEqual({
      closing: 'service_closed',
      installing: 'model_installing',
      missing: 'model_missing',
      busy: 'busy',
      closedWorker: 'worker_unavailable',
    });
  });
});
