import { describe, it } from 'bun:test';
import { VoiceModelSchema, VoiceRuntimeSchema, VOICE_RUNTIME_TARGETS } from '@ferretry/protocol';
import should from 'should';
import {
  estimatePeakMemory,
  findVoiceModel,
  SHERPA_WRAPPER_VERSION,
  VOICE_MODELS,
  VOICE_RUNTIMES,
  voiceRuntimeTargetFor,
} from '../../../src/lib/voice-install/index.ts';

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';

describe('the model catalog', () => {
  it('should hold the nine rows of plan §2.2, batch first and streaming last', () => {
    should(VOICE_MODELS.map(model => [model.id, model.role])).deepEqual([
      ['parakeet-tdt-0.6b-v3-int8', 'batch'],
      ['parakeet-tdt-0.6b-v2-fp16', 'batch'],
      ['whisper-turbo', 'batch'],
      ['whisper-large-v3', 'batch'],
      ['qwen3-asr-0.6b-int8', 'batch'],
      ['cohere-transcribe-int8', 'batch'],
      ['canary-180m-flash-int8', 'batch'],
      ['nemotron-streaming-0.6b-560ms-int8', 'streaming'],
      ['parakeet-unified-0.6b-streaming-560ms-int8', 'streaming'],
    ]);
  });

  it('should parse every row through the wire schema, with unique ids', () => {
    for (const model of VOICE_MODELS) should(VoiceModelSchema.safeParse(model).success).be.true();
    should(new Set(VOICE_MODELS.map(model => model.id)).size).equal(VOICE_MODELS.length);
  });

  it('should recommend exactly Parakeet v3 for batch and Nemotron 560 ms for streaming', () => {
    const recommended = VOICE_MODELS.filter(model => model.recommended).map(model => [model.role, model.id]);
    should(recommended).deepEqual([
      ['batch', 'parakeet-tdt-0.6b-v3-int8'],
      ['streaming', 'nemotron-streaming-0.6b-560ms-int8'],
    ]);
  });

  it('should pin every archive on the sherpa-onnx asr-models release, by size and SHA-256', () => {
    for (const model of VOICE_MODELS) {
      should(model.archive.url.startsWith(RELEASE)).be.true();
      should(model.archive.url.endsWith('.tar.bz2')).be.true();
      should(model.archive.sha256).match(/^[0-9a-f]{64}$/u);
      should(model.archive.bytes).be.greaterThan(100_000_000);
    }
    should(new Set(VOICE_MODELS.map(model => model.archive.sha256)).size).equal(VOICE_MODELS.length);
  });

  it('should pin the figures the plan quotes (checked against the release assets, 2026-11-05)', () => {
    const bytes = (id: string): number | undefined => findVoiceModel(id)?.archive.bytes;
    should(bytes('parakeet-tdt-0.6b-v3-int8')).equal(487_170_055);
    should(bytes('parakeet-tdt-0.6b-v2-fp16')).equal(1_120_982_957);
    should(bytes('whisper-turbo')).equal(563_790_207);
    should(bytes('whisper-large-v3')).equal(1_068_482_488);
    should(bytes('qwen3-asr-0.6b-int8')).equal(878_702_423);
    should(bytes('cohere-transcribe-int8')).equal(1_699_791_751);
    should(bytes('canary-180m-flash-int8')).equal(153_692_328);
    should(bytes('nemotron-streaming-0.6b-560ms-int8')).equal(463_945_051);
    should(bytes('parakeet-unified-0.6b-streaming-560ms-int8')).equal(501_360_769);
  });

  it('should name, for every row, the files the recognizer needs, each at a safe relative path', () => {
    for (const model of VOICE_MODELS) {
      should(Object.keys(model.files).length).be.greaterThanOrEqual(3);
      for (const path of Object.values(model.files)) {
        should(path.startsWith('/')).be.false();
        should(path.split('/')).not.containEql('..');
      }
      should(model.files.tokens ?? model.files.tokenizer).be.a.String();
    }
  });

  it('should mark every memory figure an estimate until the bench measures it, and keep it conservative', () => {
    for (const model of VOICE_MODELS) {
      should(model.peakMemory.basis).equal('estimate');
      should(model.peakMemory.bytes).equal(estimatePeakMemory(model.archive.extractedBytes));
      should(model.peakMemory.bytes).be.greaterThan(model.archive.extractedBytes);
    }
  });

  it('should find a row by id', () => {
    should(findVoiceModel('whisper-turbo')?.name).equal('Whisper turbo');
    should(findVoiceModel('nope')).be.undefined();
  });
});

describe('the runtime catalog', () => {
  it('should hold one pinned npm tarball per target, all at the wrapper version', () => {
    should(VOICE_RUNTIMES.map(runtime => runtime.target)).deepEqual([...VOICE_RUNTIME_TARGETS]);
    for (const runtime of VOICE_RUNTIMES) {
      should(VoiceRuntimeSchema.safeParse(runtime).success).be.true();
      should(runtime.version).equal(SHERPA_WRAPPER_VERSION);
      should(runtime.archive.format).equal('tgz');
      should(runtime.archive.url).equal(
        `https://registry.npmjs.org/sherpa-onnx-${runtime.target}/-/sherpa-onnx-${runtime.target}-${runtime.version}.tgz`,
      );
      should(runtime.archive.sha256).match(/^[0-9a-f]{64}$/u);
    }
  });

  it('should find its siblings in-tree on every target, so no library path variable is set', () => {
    should(VOICE_RUNTIMES.map(runtime => [runtime.target, runtime.libraryLookup])).deepEqual([
      ['linux-x64', 'origin'],
      ['linux-arm64', 'origin'],
      ['darwin-arm64', 'loader-path'],
    ]);
  });

  it('should list the addon and the three libraries with the platform extension', () => {
    const mac = VOICE_RUNTIMES.find(runtime => runtime.target === 'darwin-arm64');
    const linux = VOICE_RUNTIMES.find(runtime => runtime.target === 'linux-x64');
    should(linux?.libraries).deepEqual(['libsherpa-onnx-c-api.so', 'libonnxruntime.so', 'libsherpa-onnx-cxx-api.so']);
    should(mac?.libraries).deepEqual([
      'libsherpa-onnx-c-api.dylib',
      'libonnxruntime.dylib',
      'libsherpa-onnx-cxx-api.dylib',
    ]);
    should(mac?.addon).equal('sherpa-onnx.node');
  });
});

describe('voiceRuntimeTargetFor', () => {
  it.each([
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['darwin', 'arm64', 'darwin-arm64'],
  ])('should take the %s %s runtime as %s', (platform, arch, expected) => {
    should(voiceRuntimeTargetFor(platform, arch)).equal(expected);
  });

  it.each([
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'riscv64'],
    ['freebsd', 'x64'],
  ])('should say plainly that %s %s has no prebuilt runtime', (platform, arch) => {
    const target = voiceRuntimeTargetFor(platform, arch);
    should(typeof target === 'string' ? '' : target.unsupported).match(/no prebuilt runtime/u);
  });
});
