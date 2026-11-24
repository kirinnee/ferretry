/**
 * Proves the Google transcriber's catalog entry keeps the catalog's pinning rules and says where it comes from and under
 * what licence, and that the runtime binary pinned here is byte for byte the one the installed `@mediapipe/tasks-audio`
 * ships — so a version bump that forgets the pin fails here.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import {
  GOOGLE_TRANSCRIBER_MODEL,
  GOOGLE_TRANSCRIBER_REPOSITORY,
  GOOGLE_TRANSCRIBER_REVISION,
  MEDIAPIPE_AUDIO_RUNTIME,
  MEDIAPIPE_AUDIO_VERSION,
} from '../../../../app/lib/stt/google-transcriber-model.ts';
import {
  modelDownloadBytes,
  ON_DEVICE_MODELS,
  onDeviceModel,
  SPEECH_RUNTIMES,
  validateModelCatalog,
} from '../../../../app/lib/stt/model-catalog.ts';

const VOICE_DIR = join(import.meta.dir, '..', '..', '..', '..');

describe('the Google AudioTranscriber model', () => {
  it('keeps every pinning rule and is the last entry of the catalog', () => {
    should(validateModelCatalog([GOOGLE_TRANSCRIBER_MODEL])).eql([]);
    should(validateModelCatalog(ON_DEVICE_MODELS)).eql([]);
    should(ON_DEVICE_MODELS.at(-1)).equal(GOOGLE_TRANSCRIBER_MODEL);
    should(onDeviceModel('google-audio-transcriber')).equal(GOOGLE_TRANSCRIBER_MODEL);
    should(SPEECH_RUNTIMES['mediapipe-audio']).equal(MEDIAPIPE_AUDIO_RUNTIME);
  });

  it('comes from Google’s own repository at one commit, as one file with its Hugging Face size and SHA-256', () => {
    should(GOOGLE_TRANSCRIBER_REPOSITORY).equal('litert-community/parakeet-tdt-0.6b-v3');
    should(GOOGLE_TRANSCRIBER_REVISION).match(/^[0-9a-f]{40}$/u);
    should(GOOGLE_TRANSCRIBER_MODEL.files).eql([
      {
        role: 'model',
        label: 'Speech model',
        url: `https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/${GOOGLE_TRANSCRIBER_REVISION}/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm`,
        bytes: 614_588_752,
        sha256: '66c5a74cf6c2c1d2b990901f6cece5bb53e3214dbceafa0989900a6f0eeb3504',
      },
    ]);
  });

  it('says its licence, its credit and that it hears live', () => {
    should(GOOGLE_TRANSCRIBER_MODEL.licence).equal('CC-BY-4.0');
    should(MEDIAPIPE_AUDIO_RUNTIME.licence).equal('Apache-2.0');
    // The card's details say the credit: its summary, its measured line, then who made it, under what licence.
    should(GOOGLE_TRANSCRIBER_MODEL.label).containEql('Parakeet TDT 0.6B v3');
    should(GOOGLE_TRANSCRIBER_MODEL.streaming).be.true();
    should(GOOGLE_TRANSCRIBER_MODEL.languages).have.length(25);
  });

  it('downloads the model and the runtime, and nothing else', () => {
    should(modelDownloadBytes(GOOGLE_TRANSCRIBER_MODEL)).equal(614_588_752 + 21_979_681);
  });
});

describe('the pinned MediaPipe audio runtime', () => {
  it('is the exact binary the installed @mediapipe/tasks-audio ships', () => {
    const entry = Bun.resolveSync('@mediapipe/tasks-audio/package.json', VOICE_DIR);
    const packageJson = JSON.parse(readFileSync(entry, 'utf8')) as { version: string; license: string };
    should(packageJson.version).equal(MEDIAPIPE_AUDIO_VERSION);
    should(packageJson.license).equal('Apache-2.0');
    const binary = readFileSync(join(dirname(entry), 'wasm', 'audio_wasm_module_internal.wasm'));
    should(binary.length).equal(MEDIAPIPE_AUDIO_RUNTIME.file.bytes);
    should(createHash('sha256').update(binary).digest('hex')).equal(MEDIAPIPE_AUDIO_RUNTIME.file.sha256);
  });

  it('ships the loader the worker imports, which keeps a Module that is already set and honours instantiateWasm', () => {
    const entry = Bun.resolveSync('@mediapipe/tasks-audio/package.json', VOICE_DIR);
    const loader = readFileSync(join(dirname(entry), 'wasm', 'audio_wasm_module_internal.js'), 'utf8');
    should(loader).containEql('Module["instantiateWasm"]');
    const bundle = readFileSync(join(dirname(entry), 'audio_bundle.mjs'), 'utf8');
    should(bundle).containEql('self.Module&&');
  });
});
