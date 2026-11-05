import { describe, it } from 'bun:test';
import should from 'should';
import {
  VOICE_ENGINE_CODES,
  VoiceConfigSchema,
  VoiceEngineViewSchema,
  VoiceInstallProgressSchema,
  VoiceModelRequestSchema,
  VoiceModelSchema,
  VoiceRuntimeSchema,
} from '../../src/lib/index.ts';

const SHA = 'a'.repeat(64);
const ARCHIVE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/x.tar.bz2',
  format: 'tar.bz2',
  bytes: 10,
  sha256: SHA,
  extractedBytes: 20,
} as const;
const MODEL = {
  id: 'x-int8',
  name: 'X',
  role: 'batch',
  summary: 'a model',
  weight: 'standard',
  sherpaType: 'nemo-transducer',
  files: { encoder: 'encoder.onnx' },
  languages: ['English'],
  archive: ARCHIVE,
  peakMemory: { bytes: 1, basis: 'estimate' },
  recommended: false,
} as const;

describe('the voice engine wire schemas', () => {
  it('should accept a catalog row and refuse a plain-http archive', () => {
    should(VoiceModelSchema.safeParse(MODEL).success).be.true();
    should(
      VoiceModelSchema.safeParse({ ...MODEL, archive: { ...ARCHIVE, url: 'http://example.test/x.tar.bz2' } }).success,
    ).be.false();
  });

  it.each([
    ['an upper-case hash', { ...ARCHIVE, sha256: 'A'.repeat(64) }],
    ['a short hash', { ...ARCHIVE, sha256: 'abc' }],
    ['a zero size', { ...ARCHIVE, bytes: 0 }],
    ['an unknown format', { ...ARCHIVE, format: 'zip' }],
  ])('should refuse %s', (_label, archive) => {
    should(VoiceModelSchema.safeParse({ ...MODEL, archive }).success).be.false();
  });

  it.each(['Upper', 'has space', '-lead', ''])('should refuse the model id %p', id => {
    should(VoiceModelSchema.safeParse({ ...MODEL, id }).success).be.false();
  });

  it('should refuse an unknown key on a row, so a typo does not slip through', () => {
    should(VoiceModelSchema.safeParse({ ...MODEL, color: 'blue' }).success).be.false();
  });

  it('should accept a runtime and refuse an unknown target', () => {
    const runtime = {
      target: 'linux-x64',
      packageName: 'sherpa-onnx-linux-x64',
      version: '2.0.1',
      archive: { ...ARCHIVE, format: 'tgz' },
      addon: 'sherpa-onnx.node',
      libraries: ['libsherpa-onnx-c-api.so'],
      libraryLookup: 'origin',
    };
    should(VoiceRuntimeSchema.safeParse(runtime).success).be.true();
    should(VoiceRuntimeSchema.safeParse({ ...runtime, target: 'win32-x64' }).success).be.false();
  });

  it('should parse a view with an install under way', () => {
    const view = {
      target: 'linux-x64',
      runtime: {
        source: 'downloaded',
        version: '2.0.1',
        wrapperVersion: '2.0.1',
        install: { state: 'not-installed', partialBytes: 0 },
      },
      models: [{ ...MODEL, install: { state: 'not-installed', partialBytes: 5 }, active: false }],
      active: { batch: null, streaming: null },
      install: {
        modelId: 'x-int8',
        status: 'running',
        component: 'model',
        phase: 'downloading',
        bytesDone: 5,
        bytesTotal: 10,
        startedAt: '2026-11-05T12:00:00.000Z',
      },
      warnings: [],
    };
    should(VoiceEngineViewSchema.safeParse(view).success).be.true();
  });

  it('should carry a failure with its code and a sentence', () => {
    const parsed = VoiceInstallProgressSchema.safeParse({
      modelId: 'x',
      status: 'failed',
      component: 'model',
      phase: 'verifying',
      bytesDone: 10,
      bytesTotal: 10,
      code: VOICE_ENGINE_CODES.hashMismatch,
      message: 'the download does not match its pinned SHA-256',
      startedAt: '2026-11-05T12:00:00.000Z',
      finishedAt: '2026-11-05T12:01:00.000Z',
    });
    should(parsed.success).be.true();
  });

  it('should require a model id on every act and refuse extra keys', () => {
    should(VoiceModelRequestSchema.safeParse({ id: 'x' }).success).be.true();
    should(VoiceModelRequestSchema.safeParse({}).success).be.false();
    should(VoiceModelRequestSchema.safeParse({ id: 'x', force: true }).success).be.false();
  });

  it('should give every failure code a distinct value', () => {
    const values = Object.values(VOICE_ENGINE_CODES);
    should(new Set(values).size).equal(values.length);
    for (const value of values) should(value).match(/^voice_/u);
  });
});

describe('voice.yaml › engine', () => {
  it('should default to an empty engine block, so a file without one reads as before', () => {
    should(VoiceConfigSchema.parse({}).engine).deepEqual({});
  });

  it('should keep a model for each role and an absolute runtime path', () => {
    const parsed = VoiceConfigSchema.parse({
      engine: {
        batch: 'whisper-turbo',
        streaming: 'nemotron-streaming-0.6b-560ms-int8',
        runtimePath: '/opt/sherpa/lib',
      },
    });
    should(parsed.engine).deepEqual({
      batch: 'whisper-turbo',
      streaming: 'nemotron-streaming-0.6b-560ms-int8',
      runtimePath: '/opt/sherpa/lib',
    });
  });

  it.each([['relative/path'], ['./here'], ['~/sherpa']])(
    'should refuse the runtime path %p because it is not absolute',
    path => {
      const result = VoiceConfigSchema.safeParse({ engine: { runtimePath: path } });
      should(result.success).be.false();
    },
  );

  it('should refuse an empty model id and an unknown engine key', () => {
    should(VoiceConfigSchema.safeParse({ engine: { batch: '' } }).success).be.false();
    should(VoiceConfigSchema.safeParse({ engine: { gpu: true } }).success).be.false();
  });
});
