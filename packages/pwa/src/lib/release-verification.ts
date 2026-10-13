/**
 * THE RELEASE VERIFIER — the decision the service worker makes before a byte of a new release is
 * allowed to serve the app.
 *
 * Pure: it takes the bytes the worker fetched and the trust it pinned, and answers accepted or a
 * named refusal. It never fetches, never stores and never reads a clock, so every refusal is
 * provable without a browser (`tests/unit/release-verification.test.ts`). WebCrypto is used for
 * Ed25519 and SHA-256 because both a worker and a page already have it; nothing is imported.
 *
 * WHAT IS PINNED, AND WHEN. The first install pins the key compiled into the worker that installed
 * it (trust on first use — the first install trusts whatever the site served at that moment). From
 * then on the PINNED set decides, not the key a later worker carries: a deploy that rebuilt the
 * worker around its own key gains nothing by it. A key enters the set only one way — announced as
 * `nextKey` by a release signed with a key already in it — and the old key leaves the set the first
 * time a release signed by the new one is accepted. See `docs/pwa-release-signing.md`.
 */

import {
  type ReleaseManifest,
  type ReleaseOrder,
  compareReleases,
  fromBase64Url,
  parseReleaseManifest,
  parseReleaseSignature,
  toBase64Url,
} from './release-manifest.ts';

/** What the worker keeps between releases, in its own IndexedDB. */
export interface ReleaseTrust {
  /** SPKI base64url keys a release may be signed with. Never empty once pinned. */
  readonly keys: readonly string[];
  /** The release this worker is serving, or `null` before the first one was accepted. */
  readonly installed: ReleaseOrder | null;
}

export type ReleaseRefusal =
  /** The signature file is the build's "no key" marker on an origin that may not run one. */
  | 'unsigned'
  /** The list or the signature is not well-formed. */
  | 'malformed'
  /** Signed, but by a key this app never pinned. */
  | 'unknown-key'
  /** Claims a pinned key, and the signature does not verify. */
  | 'bad-signature'
  /** A valid release that is older than the one already installed. */
  | 'older'
  /** A listed file's bytes are not the bytes the list names. */
  | 'hash-mismatch';

export type ReleaseDecision =
  | {
      readonly accepted: true;
      readonly manifest: ReleaseManifest;
      /** The trust to store once every file has also checked out. */
      readonly trust: ReleaseTrust;
    }
  /** A dev build on a developer's own machine: nothing is verified and nothing is cached. */
  | { readonly accepted: false; readonly unverified: true }
  | { readonly accepted: false; readonly unverified?: never; readonly refusal: ReleaseRefusal };

export const sha256Base64Url = async (bytes: Uint8Array): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

/** The trust a worker starts from the first time it runs: its own compiled-in key, and nothing installed. */
export const firstUseTrust = (compiledKey: string): ReleaseTrust => ({ keys: [compiledKey], installed: null });

const verifyWith = async (key: string, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> => {
  const spki = fromBase64Url(key);
  if (spki === null) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      spki as Uint8Array<ArrayBuffer>,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature as Uint8Array<ArrayBuffer>,
      bytes as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return false;
  }
};

const refuse = (refusal: ReleaseRefusal): ReleaseDecision => ({ accepted: false, refusal });

export interface ReleaseCandidate {
  /** The exact bytes of `release-manifest.json` as served. */
  readonly manifestBytes: Uint8Array;
  /** The text of `release-manifest.sig` as served. */
  readonly signatureText: string;
}

/**
 * Checks a release's list and signature against the pinned trust.
 *
 * ORDER IS PART OF THE CONTRACT: the signature is checked over the raw bytes BEFORE they are parsed,
 * so nothing an unsigned list says — its version included — can influence the decision.
 */
export const verifyReleaseManifest = async (
  candidate: ReleaseCandidate,
  trust: ReleaseTrust,
  options: { readonly allowUnsigned: boolean },
): Promise<ReleaseDecision> => {
  const signature = parseReleaseSignature(candidate.signatureText);
  if (signature === null) return refuse('malformed');
  if (signature.kind === 'unsigned')
    return options.allowUnsigned ? { accepted: false, unverified: true } : refuse('unsigned');

  let signer: string | undefined;
  for (const key of trust.keys) {
    const spki = fromBase64Url(key);
    if (spki !== null && (await sha256Base64Url(spki)) === signature.keyFingerprint) signer = key;
  }
  if (signer === undefined) return refuse('unknown-key');
  if (!(await verifyWith(signer, signature.signature, candidate.manifestBytes))) return refuse('bad-signature');

  const manifest = parseReleaseManifest(candidate.manifestBytes);
  if (manifest === null) return refuse('malformed');
  if (trust.installed !== null && compareReleases(manifest, trust.installed) < 0) return refuse('older');

  const keys = manifest.nextKey === undefined || manifest.nextKey === signer ? [signer] : [signer, manifest.nextKey];
  return {
    accepted: true,
    manifest,
    trust: { keys, installed: { version: manifest.version, createdAt: manifest.createdAt } },
  };
};

/**
 * Checks one fetched file against the list. A file the list does not name is a mismatch too: the
 * caller only ever asks about listed paths, so an unlisted one means the caller is wrong, and the
 * safe answer to "is this verified?" is no.
 */
export const verifyReleaseFile = async (manifest: ReleaseManifest, path: string, bytes: Uint8Array): Promise<boolean> =>
  Object.hasOwn(manifest.files, path) && manifest.files[path] === (await sha256Base64Url(bytes));

/** Plain words for each refusal, for the page and the worker's own log. Never jargon. */
export const RELEASE_REFUSAL_WORDS: Readonly<Record<ReleaseRefusal, string>> = {
  unsigned: 'it was not signed',
  malformed: 'its signature or file list was damaged',
  'unknown-key': 'it was signed with a key this app does not trust',
  'bad-signature': 'its signature did not match',
  older: 'it is older than the version you have',
  'hash-mismatch': 'one of its files was not the file that was signed',
};
