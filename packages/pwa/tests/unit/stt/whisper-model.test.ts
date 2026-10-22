/**
 * The two Whisper entries keep every catalog rule, pin exactly the files transformers.js reads at one
 * commit of their own repository, share the transformers.js runtime bundle, and the runtime hash in
 * source is the hash of the `onnxruntime-web` binary actually installed — so a version bump of either
 * package that forgets the constants fails here.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import { RELEASE_CACHE_PREFIX } from '../../../src/lib/release-keeper.ts';
import {
  modelDownloadBytes,
  ON_DEVICE_MODEL_IDS,
  ON_DEVICE_MODELS,
  onDeviceModel,
  runtimeBundle,
  SPEECH_RUNTIMES,
  validateModelCatalog,
} from '../../../src/lib/stt/model-catalog.ts';
import { ORT_RUNTIME_VERSION } from '../../../src/lib/stt/parakeet-model.ts';
import {
  TRANSFORMERS_JS_VERSION,
  WHISPER_BASE_EN_CATALOG_MODEL,
  WHISPER_BASE_EN_FILES,
  WHISPER_RUNTIME_FILE,
  WHISPER_TINY_EN_CATALOG_MODEL,
  WHISPER_TINY_EN_FILES,
} from '../../../src/lib/stt/whisper-model.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');
const WHISPER = [WHISPER_TINY_EN_CATALOG_MODEL, WHISPER_BASE_EN_CATALOG_MODEL] as const;

/** Every file transformers.js 4.3.1's Whisper pipeline asks for, at dtype q8. */
const TRANSFORMERS_JS_READS = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

describe('the Whisper catalog entries', () => {
  it('keep every pinning rule, alongside every other entry', () => {
    should(validateModelCatalog(WHISPER)).eql([]);
    should(validateModelCatalog(ON_DEVICE_MODELS)).eql([]);
  });

  it('are listed after Moonshine, tiny before base, and found by id', () => {
    should(ON_DEVICE_MODEL_IDS.indexOf('whisper-base-en')).equal(ON_DEVICE_MODEL_IDS.indexOf('whisper-tiny-en') + 1);
    should(ON_DEVICE_MODEL_IDS.indexOf('whisper-tiny-en')).equal(ON_DEVICE_MODEL_IDS.indexOf('moonshine-base-en') + 1);
    should(onDeviceModel('whisper-tiny-en')).equal(WHISPER_TINY_EN_CATALOG_MODEL);
    should(onDeviceModel('whisper-base-en')).equal(WHISPER_BASE_EN_CATALOG_MODEL);
  });

  it('are English-only, MIT, after-Stop Whisper models on the transformers.js runtime', () => {
    for (const model of WHISPER) {
      should(model.family).equal('whisper');
      should(model.licence).equal('MIT');
      should(model.languages).eql(['en']);
      should(model.runtime).equal('transformers-js');
      should(model.streaming).be.false();
      should(model.nearLive).be.false();
    }
  });

  it('pin exactly the files transformers.js reads, at the entry’s own commit', () => {
    for (const model of WHISPER) {
      const base = `https://huggingface.co/${model.source.repository}/resolve/${model.source.revision}/`;
      should(model.files.map(file => file.url.slice(base.length))).eql(TRANSFORMERS_JS_READS);
      for (const file of model.files) should(file.url.startsWith(base)).be.true();
    }
    should(WHISPER_TINY_EN_CATALOG_MODEL.files).equal(WHISPER_TINY_EN_FILES);
    should(WHISPER_BASE_EN_CATALOG_MODEL.files).equal(WHISPER_BASE_EN_FILES);
  });

  it('pin the two English repositories, each at a different commit', () => {
    should(WHISPER_TINY_EN_CATALOG_MODEL.source.repository).equal('onnx-community/whisper-tiny.en');
    should(WHISPER_BASE_EN_CATALOG_MODEL.source.repository).equal('onnx-community/whisper-base.en');
    should(WHISPER_TINY_EN_CATALOG_MODEL.source.revision).not.equal(WHISPER_BASE_EN_CATALOG_MODEL.source.revision);
  });

  it('share the tokenizer and feature-extractor bytes, and differ in every model-specific file', () => {
    const byRole = (files: typeof WHISPER_TINY_EN_FILES) => new Map(files.map(file => [file.role, file.sha256]));
    const tiny = byRole(WHISPER_TINY_EN_FILES);
    const base = byRole(WHISPER_BASE_EN_FILES);
    for (const role of ['preprocessor', 'tokenizer', 'tokenizer-config']) should(tiny.get(role)).equal(base.get(role));
    for (const role of ['config', 'generation-config', 'encoder', 'decoder'])
      should(tiny.get(role)).not.equal(base.get(role));
  });

  it('keep each model cache outside the release keeper’s pruning, and name the commit in the version', () => {
    for (const model of WHISPER) {
      should(model.cache.startsWith(RELEASE_CACHE_PREFIX)).be.false();
      should(model.versionLabel).containEql(model.source.revision.slice(0, 7));
      should(model.versionLabel).containEql('q8');
    }
  });

  it('count the shared runtime in the download, once per model', () => {
    const files = (model: (typeof WHISPER)[number]) => model.files.reduce((total, file) => total + file.bytes, 0);
    for (const model of WHISPER) should(modelDownloadBytes(model)).equal(files(model) + WHISPER_RUNTIME_FILE.bytes);
    // q8 is the smallest export: tiny's files come to about 44 MB, base's to about 80 MB.
    should(Math.round(files(WHISPER_TINY_EN_CATALOG_MODEL) / 1_000_000)).equal(44);
    should(Math.round(files(WHISPER_BASE_EN_CATALOG_MODEL) / 1_000_000)).equal(80);
  });
});

describe('the transformers.js runtime', () => {
  const runtime = SPEECH_RUNTIMES['transformers-js'];

  it('is shared, in its own cache, and pins the WebGPU-capable ONNX Runtime binary', () => {
    should(runtime.file).equal(WHISPER_RUNTIME_FILE);
    should(runtime.version).equal(TRANSFORMERS_JS_VERSION);
    should(runtime.label).containEql(ORT_RUNTIME_VERSION);
    should(runtime.shared).eql({ cache: 'fy-stt-transformers-js-v1', keyRoot: '/fy-stt/runtime/transformers-js' });
    should(runtimeBundle(runtime, '/assets/ort-wasm-simd-threaded.asyncify-x.wasm')?.files).eql([
      { ...WHISPER_RUNTIME_FILE, url: '/assets/ort-wasm-simd-threaded.asyncify-x.wasm' },
    ]);
  });

  it('is the transformers.js version installed', () => {
    const packageJson = Bun.resolveSync('@huggingface/transformers/package.json', PWA_DIR);
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    should(version).equal(TRANSFORMERS_JS_VERSION);
  });

  it('runs on the one ONNX Runtime the app ships: transformers.js resolves the version Parakeet pins', () => {
    const transformers = dirname(Bun.resolveSync('@huggingface/transformers/package.json', PWA_DIR));
    const packageJson = Bun.resolveSync('onnxruntime-web/package.json', transformers);
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    should(version).equal(ORT_RUNTIME_VERSION);
    should(packageJson).equal(Bun.resolveSync('onnxruntime-web/package.json', PWA_DIR));
  });

  it('hashes to the size and SHA-256 recorded in WHISPER_RUNTIME_FILE', () => {
    const bytes = readFileSync(Bun.resolveSync('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm', PWA_DIR));
    should(bytes.byteLength).equal(WHISPER_RUNTIME_FILE.bytes);
    should(createHash('sha256').update(bytes).digest('hex')).equal(WHISPER_RUNTIME_FILE.sha256);
  });
});
