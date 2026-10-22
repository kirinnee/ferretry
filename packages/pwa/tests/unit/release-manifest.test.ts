import { describe, it } from 'bun:test';
import should from 'should';

import {
  RELEASE_WORKER_FILE,
  formatReleaseSignature,
  isDeferredReleaseFile,
  fromBase64Url,
  parseReleaseManifest,
  parseReleaseRewrites,
  parseReleaseSignature,
  releaseKeyFromPem,
  releasePathForRequest,
  releaseStanding,
  serializeReleaseManifest,
  toBase64Url,
} from '../../src/lib/release-manifest.ts';
import { bytesOf } from '../support/release.ts';

const HASH = 'A'.repeat(43);

const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  commit: 'abcdef1',
  sequence: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
  worker: RELEASE_WORKER_FILE,
  files: { 'b.js': HASH, 'a.js': HASH, [RELEASE_WORKER_FILE]: HASH },
  ...overrides,
});

describe('serializeReleaseManifest', () => {
  it('writes files in one fixed order and ends with a newline', () => {
    // Arrange
    const input = parseReleaseManifest(bytesOf(JSON.stringify(manifest())));

    // Act
    const actual = input === null ? '' : serializeReleaseManifest(input);

    // Assert
    should(Object.keys(JSON.parse(actual).files)).eql(['a.js', 'b.js', RELEASE_WORKER_FILE]);
    should(actual.endsWith('}\n')).be.true();
  });

  it('writes nextKey only when a rotation is announced', () => {
    // Arrange
    const key = 'B'.repeat(59);
    const input = parseReleaseManifest(bytesOf(JSON.stringify(manifest({ nextKey: key }))));

    // Act
    const actual = input === null ? {} : JSON.parse(serializeReleaseManifest(input));

    // Assert
    should(actual.nextKey).equal(key);
  });
});

describe('parseReleaseManifest', () => {
  it('reads a valid list', () => {
    should(parseReleaseManifest(bytesOf(JSON.stringify(manifest())))?.version).equal('1.0.0');
  });

  it.each([
    ['bytes that are not UTF-8', Uint8Array.from([0xff, 0xfe])],
    ['text that is not JSON', bytesOf('{')],
    ['a list that does not name its worker', bytesOf(JSON.stringify(manifest({ files: { 'a.js': HASH } })))],
    [
      'a list naming the redirects file',
      bytesOf(JSON.stringify(manifest({ files: { [RELEASE_WORKER_FILE]: HASH, _redirects: HASH } }))),
    ],
    [
      'a path that climbs out',
      bytesOf(JSON.stringify(manifest({ files: { [RELEASE_WORKER_FILE]: HASH, '../x': HASH } }))),
    ],
    ['a leading slash', bytesOf(JSON.stringify(manifest({ files: { [RELEASE_WORKER_FILE]: HASH, '/x': HASH } })))],
    ['a short hash', bytesOf(JSON.stringify(manifest({ files: { [RELEASE_WORKER_FILE]: 'AA' } })))],
    ['an unknown field', bytesOf(JSON.stringify(manifest({ extra: true })))],
    ['a version that is not x.y.z', bytesOf(JSON.stringify(manifest({ version: 'v1' })))],
    ['a negative sequence', bytesOf(JSON.stringify(manifest({ sequence: -1 })))],
    ['a fractional sequence', bytesOf(JSON.stringify(manifest({ sequence: 1.5 })))],
    ['no sequence', bytesOf(JSON.stringify(manifest({ sequence: undefined })))],
  ])('refuses %s', (_name, input) => {
    should(parseReleaseManifest(input)).be.null();
  });
});

describe('releaseStanding', () => {
  it.each([
    [{ sequence: 6, commit: 'aaaaaaa' }, 'newer'],
    [{ sequence: 5, commit: 'bbbbbbb' }, 'same'],
    [{ sequence: 5, commit: 'aaaaaaa' }, 'older'],
    [{ sequence: 4, commit: 'bbbbbbb' }, 'older'],
  ] as const)('answers %j against sequence 5 of bbbbbbb as %s', (candidate, expected) => {
    should(releaseStanding(candidate, { sequence: 5, commit: 'bbbbbbb' })).equal(expected);
  });
});

describe('base64url', () => {
  it('round-trips bytes', () => {
    const input = Uint8Array.from([0, 250, 251, 252, 253, 254, 255]);
    should(fromBase64Url(toBase64Url(input))).eql(input);
  });

  it.each([
    ['padding', 'AA=='],
    ['the standard alphabet', 'a+b/'],
    ['an impossible length', 'AAAAA'],
    ['a non-canonical tail', 'AB'],
  ])('refuses %s', (_name, input) => {
    should(fromBase64Url(input)).be.null();
  });
});

describe('the signature file', () => {
  it('round-trips a signature', () => {
    // Arrange
    const signature = new Uint8Array(64).fill(9);

    // Act
    const actual = parseReleaseSignature(formatReleaseSignature(HASH, signature));

    // Assert
    should(actual).eql({ kind: 'signed', keyFingerprint: HASH, signature });
  });

  it('reads the unsigned marker', () => {
    should(parseReleaseSignature('unsigned\n')).eql({ kind: 'unsigned' });
  });

  it.each([
    ['no fingerprint', `.${toBase64Url(new Uint8Array(64))}`],
    ['no signature', `${HASH}.`],
    ['an undecodable signature', `${HASH}.!!`],
  ])('refuses %s', (_name, input) => {
    should(parseReleaseSignature(input)).be.null();
  });
});

describe('releaseKeyFromPem', () => {
  const pem = (bytes: Uint8Array) =>
    `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PUBLIC KEY-----\n`;

  it('reads the committed key, Windows line endings included', async () => {
    // Arrange
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));

    // Act
    const actual = releaseKeyFromPem(pem(spki).replaceAll('\n', '\r\n'));

    // Assert
    should(actual).equal(toBase64Url(spki));
  });

  it.each([
    ['text that is not a PEM block', 'hello'],
    ['a key of the wrong length', pem(new Uint8Array(32))],
    ['a 44-byte key that is not Ed25519', pem(new Uint8Array(44))],
  ])('refuses %s', (_name, input) => {
    should(releaseKeyFromPem(input)).be.null();
  });
});

describe('releasePathForRequest', () => {
  const files = { 'index.html': HASH, 'app/index.html': HASH, 'assets/a.js': HASH, 'docs/index.html': HASH };
  const rewrites = parseReleaseRewrites(
    '/app/* /app/index.html 200\n/old /new 301\n\n/* /index.html 200\n/gone /missing.html 200\n',
  );

  it('reads only 200 rewrites from _redirects', () => {
    should(rewrites).eql([
      { from: '/app/*', to: '/app/index.html' },
      { from: '/*', to: '/index.html' },
      { from: '/gone', to: '/missing.html' },
    ]);
  });

  it.each([
    [{ pathname: '/assets/a.js', navigate: false }, 'assets/a.js'],
    [{ pathname: '/', navigate: true }, 'index.html'],
    [{ pathname: '/app/', navigate: true }, 'app/index.html'],
    [{ pathname: '/docs', navigate: true }, 'docs/index.html'],
    [{ pathname: '/app/settings', navigate: true }, 'app/index.html'],
    [{ pathname: '/pair/x', navigate: true }, 'index.html'],
    [{ pathname: '/assets/missing.js', navigate: false }, null],
    [{ pathname: '/app/settings', navigate: false }, null],
  ])('answers %j with %p', (input, expected) => {
    should(releasePathForRequest(input, files, rewrites)).equal(expected);
  });

  it('answers nothing when a rewrite names a file the release lacks, or no rewrite matches', () => {
    should(
      releasePathForRequest({ pathname: '/gone', navigate: true }, files, [{ from: '/gone', to: '/missing.html' }]),
    ).be.null();
    should(releasePathForRequest({ pathname: '/elsewhere', navigate: true }, files, [])).be.null();
  });
});

describe('isDeferredReleaseFile', () => {
  it('defers only the speech runtime binary the build emits under assets/', () => {
    should(isDeferredReleaseFile('assets/ort-wasm-simd-threaded-BjodUpCp.wasm')).be.true();
    should(isDeferredReleaseFile('assets/ort-wasm-simd-threaded.wasm')).be.true();
    // The sherpa-onnx binary every sherpa model shares (`lib/stt/sherpa-models.ts`).
    should(isDeferredReleaseFile('assets/asr-BAU4GBSr.wasm')).be.true();
    for (const path of [
      'ort-wasm-simd-threaded.wasm',
      'assets/ort-wasm-simd-threaded-x.mjs',
      'assets/parakeet-worker-abc.js',
      'assets/app-1.js',
      'index.html',
      'assets/nested/ort-wasm-simd-threaded.wasm',
      'assets/asr-x.js',
      'assets/sherpa-worker-abc.js',
    ])
      should(isDeferredReleaseFile(path)).be.false();
  });

  it('defers Vosk’s runtime binary too, and nothing else of Vosk’s', () => {
    should(isDeferredReleaseFile('assets/vosk-Bit5K3ZQ.wasm')).be.true();
    for (const path of [
      'assets/vosk-worker-DonRcPBX.js',
      'assets/vosk-.wasm',
      'vosk-Bit5K3ZQ.wasm',
      'assets/vosk-a.b.wasm',
    ])
      should(isDeferredReleaseFile(path)).be.false();
  });
});
