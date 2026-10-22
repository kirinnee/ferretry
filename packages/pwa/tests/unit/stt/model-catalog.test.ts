/**
 * Proves the on-device model catalog holds every entry to the pinning rules — an immutable
 * `resolve/<commit>` URL in the entry's own repository, an exact size, a SHA-256 — and that the
 * shipped catalog keeps them. Each broken copy below is one rule broken once, so a failure names it.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  modelBundle,
  modelDownloadBytes,
  modelDownloadSize,
  modelSourceUrl,
  ON_DEVICE_MODEL_IDS,
  ON_DEVICE_MODELS,
  type OnDeviceModel,
  onDeviceModel,
  PARAKEET_CATALOG_MODEL,
  runtimeBundle,
  SPEECH_RUNTIMES,
  type SpeechRuntime,
  validateModelCatalog,
} from '../../../src/lib/stt/model-catalog.ts';
import { PARAKEET_CACHE, PARAKEET_TOTAL_BYTES, PARAKEET_VERSION_LABEL } from '../../../src/lib/stt/parakeet-model.ts';

const COMMIT = 'a'.repeat(40);
const SHA = 'b'.repeat(64);

const model = (overrides: Partial<OnDeviceModel> = {}): OnDeviceModel => ({
  ...PARAKEET_CATALOG_MODEL,
  source: { repository: 'org/model', revision: COMMIT },
  files: [
    {
      role: 'encoder',
      label: 'Encoder',
      url: `https://huggingface.co/org/model/resolve/${COMMIT}/encoder.onnx`,
      bytes: 10,
      sha256: SHA,
    },
  ],
  ...overrides,
});

const sharedRuntime: SpeechRuntime = {
  id: 'onnxruntime-web',
  label: 'Test runtime',
  version: '1.0.0',
  licence: 'MIT',
  file: { role: 'runtime', label: 'Speech runtime', bytes: 5, sha256: SHA },
  shared: { cache: 'fy-stt-runtime-test-v1', keyRoot: '/fy-stt/runtime/test' },
};

/** The item at `index`, which the test has just made exist. */
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};

const only = <T>(item: T | undefined): T => at(item === undefined ? [] : [item], 0);

describe('the shipped catalog', () => {
  it('keeps every pinning rule', () => {
    should(validateModelCatalog(ON_DEVICE_MODELS)).eql([]);
  });

  it('lists the models in the id order Settings shows', () => {
    should(ON_DEVICE_MODELS.map(entry => entry.id)).eql([...ON_DEVICE_MODEL_IDS]);
  });

  it('keeps Parakeet exactly where it was before the catalog existed', () => {
    should(PARAKEET_CATALOG_MODEL.cache).equal(PARAKEET_CACHE);
    should(PARAKEET_CATALOG_MODEL.keyRoot).equal('/fy-stt/parakeet');
    should(PARAKEET_CATALOG_MODEL.versionLabel).equal(PARAKEET_VERSION_LABEL);
    should(modelDownloadBytes(PARAKEET_CATALOG_MODEL)).equal(PARAKEET_TOTAL_BYTES);
    should(modelDownloadSize(PARAKEET_CATALOG_MODEL)).equal(`${Math.round(PARAKEET_TOTAL_BYTES / 1_000_000)} MB`);
  });

  it('finds an entry by id, and nothing for browser voice or an unknown id', () => {
    should(onDeviceModel('parakeet')).equal(PARAKEET_CATALOG_MODEL);
    should(onDeviceModel('browser')).be.null();
    should(onDeviceModel('nope')).be.null();
    should(onDeviceModel(null)).be.null();
    should(onDeviceModel(undefined)).be.null();
  });

  it('names where the files come from, at the pinned commit', () => {
    should(modelSourceUrl(PARAKEET_CATALOG_MODEL)).equal(
      `https://huggingface.co/${PARAKEET_CATALOG_MODEL.source.repository}/tree/${PARAKEET_CATALOG_MODEL.source.revision}`,
    );
  });
});

describe('modelBundle / runtimeBundle', () => {
  it('turns a model into the store bundle its install uses', () => {
    should(modelBundle(PARAKEET_CATALOG_MODEL)).eql({
      name: 'Parakeet',
      cache: PARAKEET_CACHE,
      keyRoot: '/fy-stt/parakeet',
      versionLabel: PARAKEET_VERSION_LABEL,
      files: PARAKEET_CATALOG_MODEL.files,
    });
  });

  it('gives a shared runtime its own bundle at the URL the build emitted, and none to an embedded one', () => {
    should(runtimeBundle(sharedRuntime, '/assets/runtime.wasm')).eql({
      name: 'Test runtime',
      cache: 'fy-stt-runtime-test-v1',
      keyRoot: '/fy-stt/runtime/test',
      versionLabel: 'Test runtime',
      files: [{ role: 'runtime', label: 'Speech runtime', bytes: 5, sha256: SHA, url: '/assets/runtime.wasm' }],
    });
    should(runtimeBundle(SPEECH_RUNTIMES['onnxruntime-web'], '/assets/ort.wasm')).be.null();
  });
});

describe('validateModelCatalog', () => {
  it('accepts a sound entry', () => {
    should(validateModelCatalog([model()])).eql([]);
  });

  it('refuses a file that is not pinned at the entry’s own commit', () => {
    for (const url of [
      'https://huggingface.co/org/model/resolve/main/encoder.onnx',
      `https://huggingface.co/other/model/resolve/${COMMIT}/encoder.onnx`,
      `https://huggingface.co/org/model/resolve/${COMMIT}/`,
      `http://huggingface.co/org/model/resolve/${COMMIT}/encoder.onnx`,
    ]) {
      const [file] = model().files;
      should(validateModelCatalog([model({ files: [{ ...only(file), url }] })])).eql([
        `parakeet: encoder is not pinned at org/model@${COMMIT}.`,
      ]);
    }
  });

  it('refuses a revision that is a branch or tag, not a commit', () => {
    const problems = validateModelCatalog([model({ source: { repository: 'org/model', revision: 'main' } })]);
    should(problems).containEql('parakeet: the revision is not a 40-hex commit.');
  });

  it('refuses a missing or malformed digest and an impossible size', () => {
    const [file] = model().files;
    should(
      validateModelCatalog([
        model({
          files: [
            { ...only(file), sha256: 'B'.repeat(64) },
            { ...only(file), role: 'decoder', bytes: 0 },
            { ...only(file), role: 'joiner', bytes: 1.5 },
          ],
        }),
      ]),
    ).eql([
      "parakeet: encoder's SHA-256 is not 64 hex digits.",
      "parakeet: decoder's size is not a positive whole number of bytes.",
      "parakeet: joiner's size is not a positive whole number of bytes.",
    ]);
  });

  it('refuses a role, an id, a cache or a key root used twice', () => {
    const [file] = model().files;
    should(validateModelCatalog([model({ files: [only(file), only(file)] })])).eql([
      'parakeet: role encoder is used twice.',
    ]);
    should(validateModelCatalog([model(), model()])).eql([
      'parakeet: id parakeet is used twice.',
      'parakeet: cache fy-stt-parakeet-v1 is used twice.',
      'parakeet: key root /fy-stt/parakeet is used twice.',
    ]);
  });

  it('refuses a bad id, a bad cache name, an unknown runtime, no languages and no files', () => {
    const broken = model({
      id: 'browser' as OnDeviceModel['id'],
      cache: 'models',
      runtime: 'nope' as OnDeviceModel['runtime'],
      languages: [],
      files: [],
    });
    should(validateModelCatalog([broken])).eql([
      'browser: the id is not a lowercase slug other than "browser".',
      'browser: cache models is not fy-stt-<name>-v<n>.',
      'browser: runtime nope is not in the catalog.',
      'browser: it names no language.',
      'browser: it pins no files.',
    ]);
  });

  it('holds a runtime to the same rules, and a shared one to a cache of its own', () => {
    const runtimes = {
      'onnxruntime-web': {
        ...sharedRuntime,
        file: { ...sharedRuntime.file, sha256: 'x', bytes: -1 },
        shared: { cache: 'fy-stt-parakeet-v1', keyRoot: '/fy-stt/parakeet' },
      },
      other: { ...sharedRuntime, id: 'onnxruntime-web' as const, shared: { cache: 'bad', keyRoot: '/r' } },
    };
    should(validateModelCatalog([PARAKEET_CATALOG_MODEL], runtimes)).eql([
      "onnxruntime-web: the runtime's SHA-256 is not 64 hex digits.",
      "onnxruntime-web: the runtime's size is not a positive whole number of bytes.",
      'onnxruntime-web: cache bad is not fy-stt-<name>-v<n>.',
      'parakeet: cache fy-stt-parakeet-v1 is used twice.',
      'parakeet: key root /fy-stt/parakeet is used twice.',
    ]);
  });
});
