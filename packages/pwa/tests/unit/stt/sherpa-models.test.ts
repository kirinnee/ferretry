/**
 * Proves the sherpa entries keep the catalog's pinning rules, that both Zipformers name the four files
 * a streaming transducer is built from, and that the runtime binary pinned here is byte for byte the
 * one the installed `@sherpaw/asr` ships — so a version bump that forgets the pin fails here.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import { ON_DEVICE_MODELS, SPEECH_RUNTIMES, validateModelCatalog } from '../../../src/lib/stt/model-catalog.ts';
import {
  MOONSHINE_BASE_MODEL,
  MOONSHINE_TINY_MODEL,
  PARAKEET_TDT_110M_MODEL,
  SHERPA_MODELS,
  SHERPA_RUNTIME,
  SHERPA_RUNTIME_VERSION,
  SHERPA_ZIPFORMER_MODEL,
} from '../../../src/lib/stt/sherpa-models.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');

describe('the sherpa models', () => {
  it('keep every pinning rule and are listed first, as the owner asked', () => {
    should(validateModelCatalog(SHERPA_MODELS)).eql([]);
    should(ON_DEVICE_MODELS[0]).equal(SHERPA_ZIPFORMER_MODEL);
    // Sherpa streaming and Moonshine first; Whisper sits between Moonshine and Parakeet small.
    should(ON_DEVICE_MODELS.slice(0, 3)).eql([...SHERPA_MODELS.slice(0, 3)]);
    should(SPEECH_RUNTIMES['sherpa-onnx']).equal(SHERPA_RUNTIME);
  });

  it('build a streaming transducer from an encoder, decoder, joiner and vocabulary, in capitals', () => {
    for (const model of SHERPA_MODELS.filter(entry => entry.streaming)) {
      should(model.recognizer).eql({ kind: 'online-transducer' });
      should(model.streaming).be.true();
      should(model.textCase).equal('upper');
      should(model.files.map(file => file.role).sort()).eql(['decoder', 'encoder', 'joiner', 'tokens']);
    }
  });

  it('decode whole takes with the files each recognizer is built from, in their own casing', () => {
    const roles = (model: (typeof SHERPA_MODELS)[number]) => model.files.map(file => file.role).sort();
    for (const model of [MOONSHINE_TINY_MODEL, MOONSHINE_BASE_MODEL]) {
      should(model.recognizer).eql({ kind: 'offline-moonshine' });
      should(roles(model)).eql(['cached-decoder', 'encoder', 'preprocessor', 'tokens', 'uncached-decoder']);
    }
    should(PARAKEET_TDT_110M_MODEL.recognizer).eql({ kind: 'offline-nemo-transducer' });
    should(roles(PARAKEET_TDT_110M_MODEL)).eql(['decoder', 'encoder', 'joiner', 'tokens']);
    for (const model of [MOONSHINE_TINY_MODEL, MOONSHINE_BASE_MODEL, PARAKEET_TDT_110M_MODEL]) {
      should(model.streaming).be.false();
      should(model.textCase).equal('as-is');
    }
    should(SHERPA_MODELS.map(model => model.id)).eql([
      'sherpa-zipformer-en',
      'moonshine-tiny-en',
      'moonshine-base-en',
      'parakeet-tdt-110m',
    ]);
  });

  it('share one runtime bundle of their own', () => {
    should(SHERPA_RUNTIME.shared).eql({ cache: 'fy-stt-runtime-sherpa-v1', keyRoot: '/fy-stt/runtime/sherpa' });
  });
});

describe('the pinned sherpa-onnx runtime', () => {
  it('is the exact binary the installed @sherpaw/asr ships', () => {
    const entry = Bun.resolveSync('@sherpaw/asr', PWA_DIR);
    const packageJson = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    should(packageJson.version).equal(SHERPA_RUNTIME_VERSION);
    const binary = readFileSync(join(dirname(entry), 'prebuilt', 'asr.wasm'));
    should(binary.length).equal(SHERPA_RUNTIME.file.bytes);
    should(createHash('sha256').update(binary).digest('hex')).equal(SHERPA_RUNTIME.file.sha256);
  });

  it('ships the loader the build aliases', () => {
    const entry = Bun.resolveSync('@sherpaw/asr', PWA_DIR);
    should(readFileSync(join(dirname(entry), 'asr-B3QtWJoU.js'), 'utf8')).containEql('wasmBinary');
  });
});
