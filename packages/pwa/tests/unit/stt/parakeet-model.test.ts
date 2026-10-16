/**
 * The pinned Parakeet model is a fixed set of commit-addressed URLs with well-formed hashes, its
 * cache sits outside the release keeper's pruning, and the runtime hash recorded in source is the
 * hash of the `onnxruntime-web` binary actually installed — so a version bump that forgets the
 * constants fails here.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import { RELEASE_CACHE_PREFIX } from '../../../src/lib/release-keeper.ts';
import {
  formatMegabytes,
  ORT_RUNTIME_FILE,
  ORT_RUNTIME_VERSION,
  PARAKEET_CACHE,
  PARAKEET_MODEL_FILES,
  PARAKEET_MODEL_ORIGIN,
  PARAKEET_REPOSITORY,
  PARAKEET_REVISION,
  PARAKEET_TOTAL_BYTES,
  PARAKEET_VERSION_LABEL,
  parakeetFiles,
} from '../../../src/lib/stt/parakeet-model.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');

describe('the pinned model files', () => {
  it('pins the revision to a full 40-character commit', () => {
    should(PARAKEET_REVISION).match(/^[0-9a-f]{40}$/u);
  });

  it('names the three model files in encoder, decoder, vocabulary order', () => {
    should(PARAKEET_MODEL_FILES.map(file => file.role)).eql(['encoder', 'decoder', 'vocabulary']);
  });

  it('fetches every file from the pinned revision of the repository, never a branch', () => {
    const base = `${PARAKEET_MODEL_ORIGIN}/${PARAKEET_REPOSITORY}/resolve/${PARAKEET_REVISION}/`;
    for (const file of PARAKEET_MODEL_FILES) {
      should(file.url.startsWith(base)).be.true();
      should(file.url.slice(base.length)).match(/^[\w.-]+$/u);
      should(file.url).not.containEql('/main');
    }
  });

  it('records a lowercase 64-hex sha256 and a positive size for every file', () => {
    for (const file of [...PARAKEET_MODEL_FILES, ORT_RUNTIME_FILE]) {
      should(file.sha256).match(/^[0-9a-f]{64}$/u);
      should(file.bytes).be.above(0);
      should(Number.isInteger(file.bytes)).be.true();
    }
  });

  it('gives each file a distinct hash and label', () => {
    const files = parakeetFiles('x');
    should(new Set(files.map(file => file.sha256)).size).equal(files.length);
    should(new Set(files.map(file => file.label)).size).equal(files.length);
  });
});

describe('parakeetFiles', () => {
  it('appends the runtime, served from the url it was given', () => {
    const files = parakeetFiles('/assets/ort-wasm-simd-threaded-abc.wasm');
    should(files).have.length(PARAKEET_MODEL_FILES.length + 1);
    should(files.slice(0, PARAKEET_MODEL_FILES.length)).eql([...PARAKEET_MODEL_FILES]);
    const runtime = files.at(-1);
    should(runtime).eql({ ...ORT_RUNTIME_FILE, url: '/assets/ort-wasm-simd-threaded-abc.wasm' });
    should(runtime?.role).equal('runtime');
  });
});

describe('PARAKEET_TOTAL_BYTES', () => {
  it('is the sum of every file, runtime included', () => {
    const sum = parakeetFiles('x').reduce((total, file) => total + file.bytes, 0);
    should(PARAKEET_TOTAL_BYTES).equal(sum);
  });
});

describe('formatMegabytes', () => {
  it('rounds decimal megabytes to the nearest whole number', () => {
    should(formatMegabytes(0)).equal('0 MB');
    should(formatMegabytes(499_999)).equal('0 MB');
    should(formatMegabytes(500_000)).equal('1 MB');
    should(formatMegabytes(1_499_999)).equal('1 MB');
    should(formatMegabytes(652_183_999)).equal('652 MB');
  });

  it('clamps a negative size to zero', () => {
    should(formatMegabytes(-5_000_000)).equal('0 MB');
  });
});

describe('labels and cache', () => {
  it('shows the first seven characters of the revision in the version label', () => {
    should(PARAKEET_VERSION_LABEL).containEql(PARAKEET_REVISION.slice(0, 7));
    should(PARAKEET_VERSION_LABEL).not.containEql(PARAKEET_REVISION.slice(0, 8));
  });

  it('keeps the model cache outside the release keeper prefix so pruning never deletes it', () => {
    should(PARAKEET_CACHE.startsWith(RELEASE_CACHE_PREFIX)).be.false();
    should(PARAKEET_CACHE).not.equal('');
  });
});

describe('the installed ONNX Runtime binary', () => {
  const packageJson = Bun.resolveSync('onnxruntime-web/package.json', PWA_DIR);
  const resolveBinary = (): string => {
    try {
      return Bun.resolveSync('onnxruntime-web/ort-wasm-simd-threaded.wasm', PWA_DIR);
    } catch {
      return join(dirname(packageJson), 'dist', 'ort-wasm-simd-threaded.wasm');
    }
  };

  it('is the package version the constants name', () => {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    should(version).equal(ORT_RUNTIME_VERSION);
  });

  it('hashes to the size and sha256 recorded in ORT_RUNTIME_FILE', () => {
    const bytes = readFileSync(resolveBinary());
    should(bytes.byteLength).equal(ORT_RUNTIME_FILE.bytes);
    should(createHash('sha256').update(bytes).digest('hex')).equal(ORT_RUNTIME_FILE.sha256);
  });
});
