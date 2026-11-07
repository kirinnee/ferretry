/**
 * The signed bytes of a link-store request (`docs/relay-protocol.md`, the catalog link store), copied byte for byte
 * from today's `packages/relay/src/lib/link-store.ts`. Only the transcript and its check live here: the daemon signs
 * through the kernel's identity signer (`signLinkStoreRequest`), and the link-store Worker verifies with the same
 * function shape, so the two cannot disagree about a signed byte. The store's wire shapes, limits and storage are
 * Catalogs'.
 */

import { z } from 'zod';
import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES } from './constants.ts';
import type { SessionCrypto } from './crypto.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

export const LINK_STORE_PROTOCOL_ID = 'ferretry-link-store/1' as const;

/** Signature labels, one per action, each ended by the length prefix of the first field after it. */
export const LINK_STORE_UPLOAD_LABEL = 'ferretry-link-store-upload-v1' as const;
export const LINK_STORE_DELETE_LABEL = 'ferretry-link-store-delete-v1' as const;
export const LINK_STORE_STATUS_LABEL = 'ferretry-link-store-status-v1' as const;

/** What a link-store request signs, one shape per action. Only the fields the transcript covers are in it. */
export type LinkStoreRequestBody =
  | {
      readonly request: 'upload';
      readonly bundleId: string;
      readonly action: 'create' | 'replace';
      readonly kind: string;
      readonly sequence: number;
      readonly expectSequence?: number;
      readonly notAfter: string;
      readonly expiresAt?: string;
      readonly installCap?: number;
      readonly fetchVerifier: string;
      readonly envelopeSha256: string;
      readonly envelopeBytes: number;
    }
  | { readonly request: 'delete'; readonly bundleId: string }
  | { readonly request: 'status'; readonly bundleIds: readonly string[] };

const text = z.string().min(1).max(4096);
const count = z.number().int().nonnegative();
const LinkStoreRequestBodySchema: z.ZodType<LinkStoreRequestBody> = z.discriminatedUnion('request', [
  z.strictObject({
    request: z.literal('upload'),
    bundleId: text,
    action: z.enum(['create', 'replace']),
    kind: text,
    sequence: count,
    expectSequence: count.optional(),
    notAfter: text,
    expiresAt: text.optional(),
    installCap: count.optional(),
    fetchVerifier: text,
    envelopeSha256: text,
    envelopeBytes: count,
  }),
  z.strictObject({ request: z.literal('delete'), bundleId: text }),
  z.strictObject({ request: z.literal('status'), bundleIds: z.array(text).max(1024) }),
]);

/** The request body from its canonical JSON bytes; `undefined` when it is not exactly one of the three shapes. */
export function parseLinkStoreRequestBody(bytes: Uint8Array): LinkStoreRequestBody | undefined {
  try {
    const parsed = LinkStoreRequestBodySchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface LinkStoreRequestContext {
  readonly daemonId: string;
  /** The store's host, as the URL the daemon discovered spells it. The store rebuilds it from its own. */
  readonly host: string;
  readonly nonce: Uint8Array;
  readonly body: LinkStoreRequestBody;
}

const field = (text: string | number | undefined): Uint8Array =>
  lengthPrefixed(utf8Bytes(text === undefined ? '' : String(text)));

/**
 * The signed message, one shape per action:
 *
 *   upload  label ‖ LP(protocolId) ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(bundleId) ‖ LP(action) ‖ LP(kind)
 *           ‖ LP(sequence) ‖ LP(expectSequence | "") ‖ LP(notAfter) ‖ LP(expiresAt | "") ‖ LP(installCap | "")
 *           ‖ LP(fetchVerifier) ‖ LP(envelopeSha256) ‖ LP(envelopeBytes)
 *   delete  label ‖ LP(protocolId) ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(bundleId)
 *   status  label ‖ LP(protocolId) ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(bundleIds sorted, joined by ",")
 *
 * Numbers are decimal text and an absent optional is the empty string, so no two requests share bytes.
 */
export function linkStoreTranscript(context: LinkStoreRequestContext): Uint8Array {
  const { body } = context;
  const head = [
    field(LINK_STORE_PROTOCOL_ID),
    field(context.daemonId),
    field(context.host),
    lengthPrefixed(context.nonce),
  ];
  switch (body.request) {
    case 'upload':
      return concatBytes([
        utf8Bytes(LINK_STORE_UPLOAD_LABEL),
        ...head,
        field(body.bundleId),
        field(body.action),
        field(body.kind),
        field(body.sequence),
        field(body.expectSequence),
        field(body.notAfter),
        field(body.expiresAt),
        field(body.installCap),
        field(body.fetchVerifier),
        field(body.envelopeSha256),
        field(body.envelopeBytes),
      ]);
    case 'delete':
      return concatBytes([utf8Bytes(LINK_STORE_DELETE_LABEL), ...head, field(body.bundleId)]);
    case 'status':
      return concatBytes([utf8Bytes(LINK_STORE_STATUS_LABEL), ...head, field([...body.bundleIds].sort().join(','))]);
  }
}

/** A signed request as it travels: the four fields, base64url where binary. */
export interface SignedLinkStoreRequest {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

export type LinkStoreRequestVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The store half. Accepts only if the key hashes to the fingerprint AND the signature verifies over the transcript
 * the STORE rebuilds from its own host, its own outstanding nonce and the request it parsed.
 */
export async function verifyLinkStoreRequest(
  crypto: SessionCrypto,
  context: LinkStoreRequestContext,
  request: SignedLinkStoreRequest,
): Promise<LinkStoreRequestVerdict> {
  const publicKey = fromBase64UrlFixed(request.publicKey, ED25519_SPKI_BYTES);
  const signature = fromBase64UrlFixed(request.signature, ED25519_SIGNATURE_BYTES);
  if (publicKey === null || signature === null) return { ok: false, reason: 'key or signature is malformed' };
  if (request.daemonId !== context.daemonId) return { ok: false, reason: 'fingerprint does not match the challenge' };
  if (request.nonce !== toBase64Url(context.nonce)) return { ok: false, reason: 'nonce does not match the challenge' };
  if (!(await publicKeyMatchesDaemonId(crypto, publicKey, context.daemonId)))
    return { ok: false, reason: 'public key does not match the fingerprint' };
  const verified = await crypto.verifyEd25519(publicKey, signature, linkStoreTranscript(context));
  return verified ? { ok: true } : { ok: false, reason: 'signature failed' };
}
