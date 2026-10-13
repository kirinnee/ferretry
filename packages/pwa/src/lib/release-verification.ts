/**
 * THE RELEASE VERIFIER — the decision the service worker makes before a byte of a new release is
 * allowed to serve the app.
 *
 * Pure: it takes signed bytes and the keys to check them against, and answers accepted or a named
 * refusal. It never fetches, never stores and never reads a clock, so every refusal is provable
 * without a browser (`tests/unit/release-verification.test.ts`). WebCrypto is used for Ed25519 and
 * SHA-256 because both a worker and a page already have it; nothing is imported.
 *
 * WHERE TRUST COMES FROM. The one anchor is the key compiled into the RUNNING worker. Nothing the
 * worker stores is trusted: IndexedDB and Cache Storage are readable and writable by any page on this
 * origin, so a script that ever ran here could rewrite them. The worker therefore keeps signed BYTES,
 * never conclusions, and re-checks them from the anchor every time it reads them:
 *
 *   - the KEY CHAIN starts at the compiled key and grows only through signed releases that announce
 *     a `nextKey` (`releaseKeyChain`) — a stored key list is never read;
 *   - the active release is the stored list and signature, re-verified against that chain.
 *
 * A key's position in the chain is its RANK. Once a release signed at some rank is installed, a
 * release signed at a lower rank is refused: that is how a planned rotation retires the old key.
 * See `docs/pwa-release-signing.md`.
 */

import {
  type ReleaseManifest,
  fromBase64Url,
  parseReleaseManifest,
  parseReleaseSignature,
  releaseStanding,
  toBase64Url,
} from './release-manifest.ts';

export type ReleaseRefusal =
  /** The signature file is the build's "no key" marker on an origin that may not run one. */
  | 'unsigned'
  /** The list or the signature is not well-formed. */
  | 'malformed'
  /** Signed by a key this app does not trust, or by a key a later release retired. */
  | 'unknown-key'
  /** Claims a trusted key, and the signature does not verify. */
  | 'bad-signature'
  /** Not newer than the installed release (a replay of an older or a sibling deploy). */
  | 'older'
  /** A listed file's bytes are not the bytes the list names. */
  | 'hash-mismatch';

/** A release exactly as it was served: the list's bytes and the signature's text. */
export interface SignedRelease {
  readonly manifestBytes: Uint8Array;
  readonly signatureText: string;
}

export const sha256Base64Url = async (bytes: Uint8Array): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

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

export type SignatureCheck =
  | { readonly ok: true; readonly manifest: ReleaseManifest; readonly signerRank: number }
  /** A dev build on a developer's own machine: nothing is verified and nothing is cached. */
  | { readonly ok: false; readonly unverified: true }
  | { readonly ok: false; readonly unverified?: never; readonly refusal: ReleaseRefusal };

const refusal = (reason: ReleaseRefusal): SignatureCheck => ({ ok: false, refusal: reason });

/**
 * Checks one signed release against a key chain.
 *
 * ORDER IS PART OF THE CONTRACT: the signature is checked over the raw bytes BEFORE they are parsed,
 * so nothing an unsigned list says can influence the decision. The fingerprint in the signature file
 * only CHOOSES the key; the signature is what authenticates.
 */
export const checkReleaseSignature = async (
  release: SignedRelease,
  chain: readonly string[],
  options: { readonly allowUnsigned: boolean },
): Promise<SignatureCheck> => {
  const signature = parseReleaseSignature(release.signatureText);
  if (signature === null) return refusal('malformed');
  if (signature.kind === 'unsigned')
    return options.allowUnsigned ? { ok: false, unverified: true } : refusal('unsigned');

  let signerRank = -1;
  for (const [rank, key] of chain.entries()) {
    const spki = fromBase64Url(key);
    if (spki !== null && (await sha256Base64Url(spki)) === signature.keyFingerprint) signerRank = rank;
  }
  const signer = chain[signerRank];
  if (signer === undefined) return refusal('unknown-key');
  if (!(await verifyWith(signer, signature.signature, release.manifestBytes))) return refusal('bad-signature');

  const manifest = parseReleaseManifest(release.manifestBytes);
  return manifest === null ? refusal('malformed') : { ok: true, manifest, signerRank };
};

/**
 * The keys a release may be signed with: the compiled-in key, then every key announced as `nextKey`
 * by a release that verifies under a key already in the chain. Stored endorsements are re-verified
 * here every time, so one that was forged or edited simply adds nothing. `check` is how each one is
 * checked; the keeper passes a remembering one so a request does not cost an Ed25519 verify.
 */
export const releaseKeyChain = async (
  compiledKey: string,
  endorsements: readonly SignedRelease[],
  check: (release: SignedRelease, chain: readonly string[]) => Promise<SignatureCheck> = (release, chain) =>
    checkReleaseSignature(release, chain, { allowUnsigned: false }),
): Promise<readonly string[]> => {
  const chain = [compiledKey];
  let grew = true;
  while (grew) {
    grew = false;
    for (const endorsement of endorsements) {
      const checked = await check(endorsement, [...chain]);
      const announced = checked.ok ? checked.manifest.nextKey : undefined;
      if (announced !== undefined && !chain.includes(announced)) {
        chain.push(announced);
        grew = true;
      }
    }
  }
  return chain;
};

/** What a candidate is compared with: the installed release's order and its signer's rank. */
export interface InstalledOrder {
  readonly sequence: number;
  readonly commit: string;
  readonly signerRank: number;
}

export type ReleaseDecision =
  | {
      readonly accepted: true;
      readonly manifest: ReleaseManifest;
      readonly signerRank: number;
      /** `same` is the installed release itself, so nothing needs fetching. */
      readonly standing: 'first' | 'newer' | 'same';
    }
  | { readonly accepted: false; readonly unverified: true }
  | { readonly accepted: false; readonly unverified?: never; readonly refusal: ReleaseRefusal };

/** Checks a candidate release against the chain and the installed release. */
export const verifyReleaseManifest = async (
  candidate: SignedRelease,
  chain: readonly string[],
  installed: InstalledOrder | null,
  options: { readonly allowUnsigned: boolean },
): Promise<ReleaseDecision> => {
  const check = await checkReleaseSignature(candidate, chain, options);
  if (!check.ok)
    return check.unverified === true
      ? { accepted: false, unverified: true }
      : { accepted: false, refusal: check.refusal };
  if (installed === null)
    return { accepted: true, manifest: check.manifest, signerRank: check.signerRank, standing: 'first' };
  if (check.signerRank < installed.signerRank) return { accepted: false, refusal: 'unknown-key' };
  const standing = releaseStanding(check.manifest, installed);
  if (standing === 'older') return { accepted: false, refusal: 'older' };
  return { accepted: true, manifest: check.manifest, signerRank: check.signerRank, standing };
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
  older: 'it is not newer than the version you have',
  'hash-mismatch': 'one of its files was not the file that was signed',
};
