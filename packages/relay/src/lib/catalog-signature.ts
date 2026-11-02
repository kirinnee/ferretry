/**
 * Signing and checking a shared catalog (docs/catalogs.md § Signed manifests).
 *
 * The publisher signs each manifest with its daemon identity — the Ed25519 key whose fingerprint IS
 * the daemon id — and the manifest lists every item version by the SHA-256 of its canonical JSON. Here
 * because the identity lives here: the same key signs handshakes, rendezvous claims and secret-import
 * offers, each under its own label, and {@link CATALOG_MANIFEST_SIGNATURE_LABEL} keeps a manifest
 * signature from ever standing in for one of those.
 *
 * WHO CHECKS. The subscriber's app checks before it shows anything, and the subscriber's own daemon
 * checks AGAIN before it installs anything, with these same functions: it never takes the app's word for
 * what the publisher said. Neither trusts the road the bytes took — a file, an offline copy, a relay.
 *
 * What a valid signature proves is narrow: these bytes came from the machine with this fingerprint. It
 * does not prove that machine is the person the reader meant (trust on first use, gap G5).
 */
import {
  CATALOG_MANIFEST_SIGNATURE_LABEL,
  CATALOG_VERSIONS_SIGNATURE_LABEL,
  type CatalogDigest,
  catalogCanonicalText,
  catalogDigestOf,
  catalogManifestSignedBytes,
  catalogVersionsSignedBytes,
  type SharedCatalogFile,
  type SharedCatalogItem,
  type SharedCatalogItemVersions,
  SharedCatalogItemVersionsSchema,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SharedCatalogManifestEntry,
  type SignedCatalogItemVersions,
  type SignedCatalogManifest,
} from '@ferretry/protocol';
import { fromBase64UrlFixed, toBase64Url, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES } from './constants.ts';
import type { DaemonIdentity, RelayCrypto } from './crypto.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

export { CATALOG_MANIFEST_SIGNATURE_LABEL, CATALOG_VERSIONS_SIGNATURE_LABEL };

/** Why a catalog did not verify. Each is a different sentence for the person. */
export type CatalogVerificationRefusal = 'signature_invalid' | 'item_mismatch' | 'not_canonical' | 'manifest_invalid';

export type CatalogVerification<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CatalogVerificationRefusal; readonly reason: string };

const refuse = <T>(refusal: CatalogVerificationRefusal, reason: string): CatalogVerification<T> => ({
  ok: false,
  refusal,
  reason,
});

/** The canonical bytes of a document, or `null` when it has no one spelling. */
const canonicalBytes = (document: unknown): Uint8Array | null => {
  const canonical = catalogCanonicalText(document);
  return canonical.ok ? utf8Bytes(canonical.text) : null;
};

/** An item's canonical text with its digest and size: the one place they are derived. `null` when it has no one spelling. */
export async function catalogItemCanonical(
  crypto: RelayCrypto,
  item: SharedCatalogItem,
): Promise<{ readonly text: string; readonly digest: CatalogDigest; readonly size: number } | null> {
  const canonical = catalogCanonicalText(item);
  if (!canonical.ok) return null;
  const bytes = utf8Bytes(canonical.text);
  return { text: canonical.text, digest: catalogDigestOf(await crypto.sha256(bytes)), size: bytes.length };
}

/** An item's digest and canonical size: what its manifest line must say. `null` when it has no one spelling. */
export async function catalogItemDigest(
  crypto: RelayCrypto,
  item: SharedCatalogItem,
): Promise<{ readonly digest: CatalogDigest; readonly size: number } | null> {
  const copy = await catalogItemCanonical(crypto, item);
  return copy === null ? null : { digest: copy.digest, size: copy.size };
}

/** What a manifest signature signs, for this manifest. */
async function manifestSignedBytes(crypto: RelayCrypto, manifest: SharedCatalogManifest): Promise<Uint8Array | null> {
  const bytes = canonicalBytes(manifest);
  return bytes === null ? null : catalogManifestSignedBytes(await crypto.sha256(bytes));
}

/**
 * Sign a manifest as this daemon. Refused when the manifest names another publisher: a daemon signs
 * only for itself, so a manifest it signs always hashes back to it.
 */
export async function signCatalogManifest(
  crypto: RelayCrypto,
  identity: DaemonIdentity,
  manifest: SharedCatalogManifest,
): Promise<CatalogVerification<SignedCatalogManifest>> {
  // Parsed here, so a typed object carrying anything the schema refuses is never signed: every reader
  // would refuse it, and the publisher would have signed something it cannot show anyone.
  const parsed = SharedCatalogManifestSchema.safeParse(manifest);
  if (!parsed.success)
    return refuse(
      'manifest_invalid',
      `This catalog cannot be signed: ${parsed.error.issues[0]?.message ?? 'it is malformed'}.`,
    );
  if (manifest.publisher !== identity.daemonId)
    return refuse('signature_invalid', 'A machine signs only catalogs it publishes itself.');
  const signed = await manifestSignedBytes(crypto, manifest);
  if (signed === null)
    return refuse('not_canonical', 'This catalog has no one canonical spelling, so it cannot be signed.');
  const sig = await crypto.signEd25519(identity.privateKey, signed);
  return { ok: true, value: { manifest, spki: toBase64Url(identity.publicKeySpki), sig: toBase64Url(sig) } };
}

/**
 * Check a signed manifest: its key hashes to the publisher it names, and the signature holds over the
 * manifest's canonical JSON under the catalog label. Answers the manifest only when both do.
 */
export async function verifySignedCatalogManifest(
  crypto: RelayCrypto,
  signed: SignedCatalogManifest,
): Promise<CatalogVerification<SharedCatalogManifest>> {
  const spki = fromBase64UrlFixed(signed.spki, ED25519_SPKI_BYTES);
  const sig = fromBase64UrlFixed(signed.sig, ED25519_SIGNATURE_BYTES);
  // No name from the manifest in this sentence: nothing in it is trusted until the signature holds.
  const notSigned = 'This catalog was not signed by the machine it names.';
  if (spki === null || sig === null) return refuse('signature_invalid', notSigned);
  if (!(await publicKeyMatchesDaemonId(crypto, spki, signed.manifest.publisher)))
    return refuse('signature_invalid', notSigned);
  const bytes = await manifestSignedBytes(crypto, signed.manifest);
  if (bytes === null)
    return refuse('not_canonical', 'This catalog has no one canonical spelling, so it cannot be checked.');
  if (!(await crypto.verifyEd25519(spki, sig, bytes))) return refuse('signature_invalid', notSigned);
  return { ok: true, value: signed.manifest };
}

/**
 * Check one item against a manifest that ALREADY VERIFIED: same publisher and catalog, the version,
 * kind and name its line lists, and the digest and size of exactly these bytes. Answers that line.
 */
export async function verifyCatalogItem(
  crypto: RelayCrypto,
  manifest: SharedCatalogManifest,
  item: SharedCatalogItem,
): Promise<CatalogVerification<SharedCatalogManifestEntry>> {
  const entry = manifest.items.find(candidate => candidate.itemId === item.itemId);
  const mismatch = `${item.name} is not the item ${manifest.name} lists, so it was not used.`;
  if (
    entry === undefined ||
    item.publisher !== manifest.publisher ||
    item.catalogId !== manifest.catalogId ||
    entry.version !== item.itemVersion ||
    entry.kind !== item.kind ||
    entry.name !== item.name ||
    entry.summary !== item.summary ||
    entry.harness !== item.harness
  )
    return refuse('item_mismatch', mismatch);
  const measured = await catalogItemDigest(crypto, item);
  if (measured === null)
    return refuse('not_canonical', `${item.name} has no one canonical spelling, so it cannot be checked.`);
  if (measured.digest !== entry.digest || measured.size !== entry.size) return refuse('item_mismatch', mismatch);
  return { ok: true, value: entry };
}

/** A whole catalog file: the manifest's signature, then every item it carries. */
export async function verifySharedCatalogFile(
  crypto: RelayCrypto,
  file: SharedCatalogFile,
): Promise<CatalogVerification<SharedCatalogManifest>> {
  const manifest = await verifySignedCatalogManifest(crypto, file.signedManifest);
  if (!manifest.ok) return manifest;
  for (const item of file.items) {
    const checked = await verifyCatalogItem(crypto, manifest.value, item);
    if (!checked.ok) return checked;
  }
  return manifest;
}

// ── The signed version list of one item in one catalog ───────────────────────────────────────────

/** What a version-list signature signs, for this list. */
async function versionsSignedBytes(
  crypto: RelayCrypto,
  versions: SharedCatalogItemVersions,
): Promise<Uint8Array | null> {
  const bytes = canonicalBytes(versions);
  return bytes === null ? null : catalogVersionsSignedBytes(await crypto.sha256(bytes));
}

/**
 * Sign a version list as this daemon, under the version-list label. Refused when the list names another
 * publisher, as a manifest is.
 */
export async function signCatalogItemVersions(
  crypto: RelayCrypto,
  identity: DaemonIdentity,
  versions: SharedCatalogItemVersions,
): Promise<CatalogVerification<SignedCatalogItemVersions>> {
  const parsed = SharedCatalogItemVersionsSchema.safeParse(versions);
  if (!parsed.success)
    return refuse(
      'manifest_invalid',
      `This version list cannot be signed: ${parsed.error.issues[0]?.message ?? 'it is malformed'}.`,
    );
  if (versions.publisher !== identity.daemonId)
    return refuse('signature_invalid', 'A machine signs only version lists for catalogs it publishes itself.');
  const signed = await versionsSignedBytes(crypto, versions);
  if (signed === null)
    return refuse('not_canonical', 'This version list has no one canonical spelling, so it cannot be signed.');
  const sig = await crypto.signEd25519(identity.privateKey, signed);
  return { ok: true, value: { versions, spki: toBase64Url(identity.publicKeySpki), sig: toBase64Url(sig) } };
}

/**
 * Check a signed version list on its own: its key hashes to the publisher it names, and the signature
 * holds over its canonical JSON under the version-list label (a manifest signature never does).
 */
export async function verifySignedCatalogItemVersions(
  crypto: RelayCrypto,
  signed: SignedCatalogItemVersions,
): Promise<CatalogVerification<SharedCatalogItemVersions>> {
  const spki = fromBase64UrlFixed(signed.spki, ED25519_SPKI_BYTES);
  const sig = fromBase64UrlFixed(signed.sig, ED25519_SIGNATURE_BYTES);
  const notSigned = 'This version list was not signed by the machine it names.';
  if (spki === null || sig === null) return refuse('signature_invalid', notSigned);
  if (!(await publicKeyMatchesDaemonId(crypto, spki, signed.versions.publisher)))
    return refuse('signature_invalid', notSigned);
  const bytes = await versionsSignedBytes(crypto, signed.versions);
  if (bytes === null)
    return refuse('not_canonical', 'This version list has no one canonical spelling, so it cannot be checked.');
  if (!(await crypto.verifyEd25519(spki, sig, bytes))) return refuse('signature_invalid', notSigned);
  return { ok: true, value: signed.versions };
}

/**
 * Check one item against a manifest that ALREADY VERIFIED and the signed version list that goes with it:
 * the same key signed both, the list is for this catalog and item at the manifest's revision and instant,
 * its current version and digest are the manifest line's, and the item is exactly the version it offers.
 * Answers the offered line.
 */
export async function verifyCatalogItemAgainstVersions(
  crypto: RelayCrypto,
  manifest: SharedCatalogManifest,
  manifestSpki: string,
  signedVersions: SignedCatalogItemVersions,
  item: SharedCatalogItem,
): Promise<CatalogVerification<SharedCatalogItemVersions['offered'][number]>> {
  const mismatch = `${item.name} is not a version ${manifest.name} offers, so it was not used.`;
  if (signedVersions.spki !== manifestSpki)
    return refuse('signature_invalid', 'This version list was not signed by the machine that signed the catalog.');
  const checked = await verifySignedCatalogItemVersions(crypto, signedVersions);
  if (!checked.ok) return checked;
  const list = checked.value;
  const line = manifest.items.find(candidate => candidate.itemId === list.itemId);
  const currentOffered = list.offered.find(offered => offered.version === list.current);
  if (
    list.publisher !== manifest.publisher ||
    list.catalogId !== manifest.catalogId ||
    line === undefined ||
    list.revision !== manifest.revision ||
    list.issuedAt !== manifest.issuedAt ||
    list.current !== line.version ||
    currentOffered?.digest !== line.digest ||
    currentOffered.size !== line.size ||
    currentOffered.summary !== line.summary
  )
    return refuse('item_mismatch', mismatch);
  const offered = list.offered.find(candidate => candidate.version === item.itemVersion);
  if (
    offered === undefined ||
    item.itemId !== list.itemId ||
    item.publisher !== manifest.publisher ||
    item.catalogId !== manifest.catalogId ||
    item.kind !== line.kind ||
    item.name !== line.name ||
    item.harness !== line.harness ||
    item.summary !== offered.summary
  )
    return refuse('item_mismatch', mismatch);
  const measured = await catalogItemDigest(crypto, item);
  if (measured === null)
    return refuse('not_canonical', `${item.name} has no one canonical spelling, so it cannot be checked.`);
  if (measured.digest !== offered.digest || measured.size !== offered.size) return refuse('item_mismatch', mismatch);
  return { ok: true, value: offered };
}
