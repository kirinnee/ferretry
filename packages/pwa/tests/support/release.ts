/**
 * Real Ed25519 keys and real signed releases for the release-check suites. Nothing here is a stub:
 * every signature is made by WebCrypto and verified by the same code the service worker runs, so a
 * refusal a suite asserts is a refusal the worker would make.
 */
import {
  type ReleaseManifest,
  RELEASE_WORKER_FILE,
  formatReleaseSignature,
  serializeReleaseManifest,
  toBase64Url,
} from '../../src/lib/release-manifest.ts';
import { sha256Base64Url } from '../../src/lib/release-verification.ts';

export interface ReleaseSigner {
  /** SPKI base64url, the spelling the trust and `nextKey` use. */
  readonly publicKey: string;
  readonly fingerprint: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export const releaseSigner = async (): Promise<ReleaseSigner> => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return {
    publicKey: toBase64Url(spki),
    fingerprint: await sha256Base64Url(spki),
    sign: async bytes =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, bytes as Uint8Array<ArrayBuffer>)),
  };
};

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A release's files as text, the way a suite thinks about them. */
export type ReleaseFiles = Readonly<Record<string, string>>;

const DEFAULT_RELEASE_FILES: ReleaseFiles = {
  'index.html': '<!doctype html><title>landing</title>',
  'app/index.html': '<!doctype html><title>app</title>',
  'assets/app-1.js': 'console.log(1)',
  [RELEASE_WORKER_FILE]: 'self.addEventListener("fetch", () => {})',
};

export interface BuiltRelease {
  readonly manifest: ReleaseManifest;
  readonly manifestBytes: Uint8Array;
  readonly signatureText: string;
  readonly files: ReleaseFiles;
}

export const buildRelease = async (
  signer: ReleaseSigner,
  options: {
    readonly version?: string;
    readonly createdAt?: string;
    readonly commit?: string;
    readonly files?: ReleaseFiles;
    readonly nextKey?: string;
  } = {},
): Promise<BuiltRelease> => {
  const files = options.files ?? DEFAULT_RELEASE_FILES;
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) hashes[path] = await sha256Base64Url(bytesOf(text));
  const manifest: ReleaseManifest = {
    version: options.version ?? '1.0.0',
    commit: options.commit ?? 'abcdef1',
    createdAt: options.createdAt ?? '2026-10-01T00:00:00.000Z',
    worker: RELEASE_WORKER_FILE,
    files: hashes,
    ...(options.nextKey === undefined ? {} : { nextKey: options.nextKey }),
  };
  const manifestBytes = bytesOf(serializeReleaseManifest(manifest));
  const signatureText = formatReleaseSignature(signer.fingerprint, await signer.sign(manifestBytes));
  return { manifest, manifestBytes, signatureText, files };
};
