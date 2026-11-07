/** TODO(kernel contract): IdentitySigner.signCatalog, the approved kernel shape. */
import { catalogCanonicalText } from '../../../contract/wire/index.ts';
import { utf8Bytes, toBase64Url } from './kernel-wire/index.ts';
import type { LinkStoreRequestContext, SignedLinkStoreRequest } from './catalog-wire/link-store.ts';
import type { SessionCrypto as RelayCrypto } from './kernel-wire/index.ts';
import {
  catalogManifestSignedBytes,
  catalogVersionsSignedBytes,
  catalogLinkSignedBytes,
  SharedCatalogManifestSchema,
  SharedCatalogItemVersionsSchema,
  SharedCatalogLinkSchema,
} from '../../../contract/wire/index.ts';
import type {
  SharedCatalogManifest,
  SharedCatalogItemVersions,
  SharedCatalogLink,
  SignedCatalogManifest,
  SignedCatalogItemVersions,
  SignedCatalogLink,
} from '../../../contract/wire/index.ts';
export interface CatalogSigningIdentity {
  readonly daemonId: string;
  readonly signer: {
    signCatalog(input: {
      readonly kind: 'manifest' | 'versions' | 'link';
      readonly canonical: Uint8Array;
    }): Promise<{ readonly daemonId: string; readonly publicKey: string; readonly signature: string }>;
    /** TODO(kernel contract): the fixed upload/delete/status labels; the kernel supplies its identity. */
    signLinkStoreRequest?(input: {
      readonly host: string;
      readonly nonce: Uint8Array;
      readonly canonicalBody: Uint8Array;
    }): Promise<{ readonly daemonId: string; readonly publicKey: string; readonly signature: string }>;
  };
}

export async function signLinkStoreRequest(
  _crypto: RelayCrypto,
  identity: CatalogSigningIdentity,
  context: LinkStoreRequestContext,
): Promise<SignedLinkStoreRequest> {
  if (context.daemonId !== identity.daemonId) throw new Error('A machine signs only its own link-store requests.');
  const body = catalogCanonicalText(context.body);
  if (!body.ok || identity.signer.signLinkStoreRequest === undefined)
    throw new Error('The link-store request signer is unavailable.');
  const signed = await identity.signer.signLinkStoreRequest({
    host: context.host,
    nonce: context.nonce,
    canonicalBody: utf8Bytes(body.text),
  });
  if (signed.daemonId !== identity.daemonId) throw new Error('The link-store request signer changed identity.');
  return { ...signed, nonce: toBase64Url(context.nonce) };
}
export type CatalogVerificationRefusal =
  | 'signature_invalid'
  | 'item_mismatch'
  | 'not_canonical'
  | 'manifest_invalid'
  | 'link_mismatch'
  | 'link_stale';

export type CatalogVerification<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CatalogVerificationRefusal; readonly reason: string };

const refuse = <T>(refusal: CatalogVerificationRefusal, reason: string): CatalogVerification<T> => ({
  ok: false,
  refusal,
  reason,
});

const canonicalBytes = (document: unknown): Uint8Array | null => {
  const canonical = catalogCanonicalText(document);
  return canonical.ok ? utf8Bytes(canonical.text) : null;
};

async function manifestSignedBytes(crypto: RelayCrypto, manifest: SharedCatalogManifest): Promise<Uint8Array | null> {
  const bytes = canonicalBytes(manifest);
  return bytes === null ? null : catalogManifestSignedBytes(await crypto.sha256(bytes));
}

export async function signCatalogManifest(
  crypto: RelayCrypto,
  identity: CatalogSigningIdentity,
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
  const canonical = canonicalBytes(manifest);
  if (canonical === null) return refuse('not_canonical', 'This document has no canonical spelling.');
  const signature = await identity.signer.signCatalog({ kind: 'manifest', canonical });
  if (signature.daemonId !== identity.daemonId)
    return refuse('signature_invalid', 'This machine signs only for itself.');
  return { ok: true, value: { manifest, spki: signature.publicKey, sig: signature.signature } };
}

async function versionsSignedBytes(
  crypto: RelayCrypto,
  versions: SharedCatalogItemVersions,
): Promise<Uint8Array | null> {
  const bytes = canonicalBytes(versions);
  return bytes === null ? null : catalogVersionsSignedBytes(await crypto.sha256(bytes));
}

export async function signCatalogItemVersions(
  crypto: RelayCrypto,
  identity: CatalogSigningIdentity,
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
  const canonical = canonicalBytes(versions);
  if (canonical === null) return refuse('not_canonical', 'This document has no canonical spelling.');
  const signature = await identity.signer.signCatalog({ kind: 'versions', canonical });
  if (signature.daemonId !== identity.daemonId)
    return refuse('signature_invalid', 'This machine signs only for itself.');
  return { ok: true, value: { versions, spki: signature.publicKey, sig: signature.signature } };
}

async function linkSignedBytes(crypto: RelayCrypto, link: SharedCatalogLink): Promise<Uint8Array | null> {
  const bytes = canonicalBytes(link);
  return bytes === null ? null : catalogLinkSignedBytes(await crypto.sha256(bytes));
}

export async function signCatalogLink(
  crypto: RelayCrypto,
  identity: CatalogSigningIdentity,
  link: SharedCatalogLink,
): Promise<CatalogVerification<SignedCatalogLink>> {
  const parsed = SharedCatalogLinkSchema.safeParse(link);
  if (!parsed.success)
    return refuse(
      'manifest_invalid',
      `This link cannot be signed: ${parsed.error.issues[0]?.message ?? 'it is malformed'}.`,
    );
  if (link.publisher !== identity.daemonId)
    return refuse('signature_invalid', 'A machine signs only links it publishes itself.');
  const signed = await linkSignedBytes(crypto, link);
  if (signed === null)
    return refuse('not_canonical', 'This link has no one canonical spelling, so it cannot be signed.');
  const canonical = canonicalBytes(link);
  if (canonical === null) return refuse('not_canonical', 'This document has no canonical spelling.');
  const signature = await identity.signer.signCatalog({ kind: 'link', canonical });
  if (signature.daemonId !== identity.daemonId)
    return refuse('signature_invalid', 'This machine signs only for itself.');
  return { ok: true, value: { link, spki: signature.publicKey, sig: signature.signature } };
}
