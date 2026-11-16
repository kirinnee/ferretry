/**
 * The signed bytes of a shared catalog's signatures (docs/catalogs.md § Signed manifests), copied from today's
 * `@ferretry/protocol` `catalogManifestSignedBytes` / `catalogVersionsSignedBytes` / `catalogLinkSignedBytes`:
 * `label ‖ 0x00 ‖ SHA-256(canonical JSON bytes)`. Each kind has its own label, so a manifest signature can never be
 * replayed as a version list, a link, a handshake signature, a rendezvous claim or a tunnel request — all of which
 * the same identity key also signs. The canonical spelling (RFC 8785) and the documents are the Catalogs plugin's;
 * the kernel signs only the digest it computes itself.
 */

import { fromBase64UrlFixed, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES } from './constants.ts';
import type { SessionCrypto } from './crypto.ts';

export const CATALOG_MANIFEST_SIGNATURE_LABEL = 'ferretry-catalog-manifest-v1' as const;
export const CATALOG_VERSIONS_SIGNATURE_LABEL = 'ferretry-catalog-versions-v1' as const;
export const CATALOG_LINK_SIGNATURE_LABEL = 'ferretry-catalog-link-v1' as const;

export type CatalogSignatureKind = 'manifest' | 'versions' | 'link';

const LABELS: Readonly<Record<CatalogSignatureKind, string>> = {
  manifest: CATALOG_MANIFEST_SIGNATURE_LABEL,
  versions: CATALOG_VERSIONS_SIGNATURE_LABEL,
  link: CATALOG_LINK_SIGNATURE_LABEL,
};

export function isCatalogSignatureKind(kind: unknown): kind is CatalogSignatureKind {
  return kind === 'manifest' || kind === 'versions' || kind === 'link';
}

/** `label ‖ 0x00 ‖ digest`, today's layout. */
export function catalogSignedBytes(kind: CatalogSignatureKind, canonicalSha256: Uint8Array): Uint8Array {
  const label = utf8Bytes(LABELS[kind]);
  const bytes = new Uint8Array(label.length + 1 + canonicalSha256.length);
  bytes.set(label, 0);
  bytes[label.length] = 0;
  bytes.set(canonicalSha256, label.length + 1);
  return bytes;
}

/**
 * Whether `signature` (base64url) is the key `publicKey` (SPKI, base64url) signing this kind of document with these
 * canonical bytes. Does not check that the key hashes to a publisher; the caller compares the daemon id it names.
 */
export async function verifyCatalogSignature(
  crypto: SessionCrypto,
  publicKey: string,
  kind: CatalogSignatureKind,
  canonical: Uint8Array,
  signature: string,
): Promise<boolean> {
  if (!isCatalogSignatureKind(kind)) return false;
  const spki = fromBase64UrlFixed(publicKey, ED25519_SPKI_BYTES);
  const sig = fromBase64UrlFixed(signature, ED25519_SIGNATURE_BYTES);
  if (spki === null || sig === null) return false;
  return await crypto.verifyEd25519(spki, sig, catalogSignedBytes(kind, await crypto.sha256(canonical)));
}
