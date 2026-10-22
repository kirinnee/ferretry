/**
 * The pinned Vosk model is the official zip at one commit-addressed URL with a well-formed hash, its
 * cache sits outside the release keeper's pruning, and the runtime hash recorded in source is the hash
 * of the `@lichess-org/vosk-browser` binary actually installed — so a version bump that forgets the
 * constants fails here.
 */

import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import should from 'should';
import { RELEASE_CACHE_PREFIX } from '../../../src/lib/release-keeper.ts';
import {
  VOSK_CACHE,
  VOSK_KEY_ROOT,
  VOSK_MODEL_FILES,
  VOSK_MODEL_ROLE,
  VOSK_REPOSITORY,
  VOSK_REVISION,
  VOSK_RUNTIME_FILE,
  VOSK_RUNTIME_ROLE,
  VOSK_RUNTIME_VERSION,
  VOSK_VERSION_LABEL,
  voskBundle,
} from '../../../src/lib/stt/vosk-model.ts';

const PWA_DIR = join(import.meta.dir, '..', '..', '..');
/** The official `vosk-model-small-en-us-0.15.zip` from alphacephei.com, as measured. */
const OFFICIAL_ZIP = { bytes: 41_205_931, sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498' };

describe('the pinned Vosk model', () => {
  it('is the official zip, byte for byte, at one commit of the mirror', () => {
    should(VOSK_REVISION).match(/^[0-9a-f]{40}$/u);
    should(VOSK_MODEL_FILES).have.length(1);
    const [zip] = VOSK_MODEL_FILES;
    should(zip).eql({
      role: VOSK_MODEL_ROLE,
      label: 'Model',
      url: `https://huggingface.co/${VOSK_REPOSITORY}/resolve/${VOSK_REVISION}/vosk-model-small-en-us-0.15.zip`,
      ...OFFICIAL_ZIP,
    });
  });

  it('names the commit in the version label and keeps its cache out of the release keeper’s pruning', () => {
    should(VOSK_VERSION_LABEL).equal(`Vosk small en-US 0.15 · ${VOSK_REVISION.slice(0, 7)}`);
    should(VOSK_CACHE.startsWith(RELEASE_CACHE_PREFIX)).be.false();
    should(VOSK_CACHE).match(/^fy-stt-[a-z0-9-]+-v\d+$/u);
  });

  it('bundles the zip and the runtime, served from the url it was given', () => {
    should(voskBundle('/assets/vosk-abc.wasm')).eql({
      name: 'Vosk',
      cache: VOSK_CACHE,
      keyRoot: VOSK_KEY_ROOT,
      versionLabel: VOSK_VERSION_LABEL,
      files: [...VOSK_MODEL_FILES, { ...VOSK_RUNTIME_FILE, url: '/assets/vosk-abc.wasm' }],
    });
    should(VOSK_RUNTIME_FILE.role).equal(VOSK_RUNTIME_ROLE);
  });
});

describe('the installed Vosk runtime binary', () => {
  const packageJson = Bun.resolveSync('@lichess-org/vosk-browser/package.json', PWA_DIR);

  it('is the package version the constants name, pinned exactly', () => {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    should(version).equal(VOSK_RUNTIME_VERSION);
    const pwa = JSON.parse(readFileSync(join(PWA_DIR, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    should(pwa.dependencies['@lichess-org/vosk-browser']).equal(VOSK_RUNTIME_VERSION);
  });

  it('hashes to the size and sha256 recorded in VOSK_RUNTIME_FILE', () => {
    const bytes = readFileSync(join(dirname(packageJson), 'dist', 'vosk.wasm'));
    should(bytes.byteLength).equal(VOSK_RUNTIME_FILE.bytes);
    should(createHash('sha256').update(bytes).digest('hex')).equal(VOSK_RUNTIME_FILE.sha256);
  });
});
