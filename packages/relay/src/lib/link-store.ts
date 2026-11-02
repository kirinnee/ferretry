/**
 * THE LINK STORE'S WIRE CONTRACT — docs/catalogs.md § Links, docs/relay-protocol.md § signing domains.
 *
 * A link store holds sealed envelopes (`link-bundle.ts`) for the daemons that upload them and hands one
 * to whoever presents the fetch token. Everything here is pure and shared by both ends — the Worker that
 * answers and the daemon that asks — so they cannot disagree about a shape or a signed byte. Cloudflare
 * is an adapter concern and is not here; the state machine that decides every answer is
 * `link-store-reducer.ts`.
 *
 * Authentication mirrors `tunnel.ts`: the same daemon identity signs a transcript that carries a label
 * per action, the protocol id, the daemon, the HOST the store is serving and a single-use nonce the
 * store issued. A signed upload therefore cannot be replayed as a delete, at another store, or twice.
 */
import { CatalogLinkKindSchema, InstantSchema, LinkBundleIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import {
  concatBytes,
  fromBase64UrlFixed,
  lengthPrefixed,
  readUint32,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  writeUint32,
} from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES, NONCE_BYTES } from './constants.ts';
import type { DaemonIdentity, RelayCrypto } from './crypto.ts';
import { parseDaemonId, publicKeyMatchesDaemonId } from './identity.ts';
import { LINK_ENVELOPE_MAX_BYTES } from './link-bundle.ts';

export const LINK_STORE_PROTOCOL_ID = 'ferretry-link-store/1' as const;
export const LINK_STORE_VERSION = 1 as const;

/** `GET`, public, no-store, CORS `*`: whether this store takes new links at all. */
export const LINK_STORE_SERVICE_PATH = '/v1/link-store' as const;
/** `POST`: mints a single-use nonce a signed request must carry. */
export const LINK_STORE_CHALLENGE_PATH = '/v1/link-store/challenge' as const;
/** `POST`, signed: the state of up to 64 of the caller's links. */
export const LINK_STORE_STATUS_PATH = '/v1/link-store/status' as const;
/** `GET` status and metrics, `PUT` the switches: behind the operator bearer. */
export const LINK_STORE_OPERATOR_PATH = '/v1/operator/link-store' as const;
/** `PUT` uploads or replaces one link, `DELETE` ends it. Both signed. */
export const linkBundlePath = (bundleId: string): string => `/v1/links/${bundleId}`;
/** `POST {token}`: what the link is, consuming nothing. */
export const linkPeekPath = (bundleId: string): string => `/v1/links/${bundleId}/peek`;
/** `POST {token}`: the sealed envelope. A one-time link is used up by it. */
export const linkFetchPath = (bundleId: string): string => `/v1/links/${bundleId}/fetch`;

/** Signature labels, one per action, each ended by the length prefix of the first field after it. */
export const LINK_STORE_UPLOAD_LABEL = 'ferretry-link-store-upload-v1' as const;
export const LINK_STORE_DELETE_LABEL = 'ferretry-link-store-delete-v1' as const;
export const LINK_STORE_STATUS_LABEL = 'ferretry-link-store-status-v1' as const;

/** How long a challenge nonce may be signed and spent. It is single-use within that window. */
export const LINK_STORE_CHALLENGE_SECONDS = 60;
/** The most links one status call asks about. */
export const LINK_STORE_STATUS_MAX_IDS = 64;
/** The most the JSON metadata of an upload may be. */
export const LINK_UPLOAD_METADATA_MAX_BYTES = 4 * 1024;

/** The one sentence every failed peek or fetch carries, whatever the cause. */
export const LINK_GONE_SENTENCE =
  'This link no longer works. It may have been used, turned off or expired. Ask the person who sent it for a new one.';

const base64UrlOfLength = (bytes: number) =>
  z.string().refine(value => fromBase64UrlFixed(value, bytes) !== null, `must be ${bytes} bytes of base64url`);

const DaemonIdField = z.string().refine(value => parseDaemonId(value) !== null, 'not a daemon fingerprint');

/** `GET /v1/link-store`. `available: false` is "not taking new links", never an error. */
export const LinkStoreAdvertisementSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  available: z.boolean(),
  maxEnvelopeBytes: z.number().int().min(1),
  maxLiveLinks: z.number().int().min(1),
});
export type LinkStoreAdvertisement = z.infer<typeof LinkStoreAdvertisementSchema>;

export const LinkStoreChallengeRequestSchema = z.strictObject({ daemonId: DaemonIdField });
export type LinkStoreChallengeRequest = z.infer<typeof LinkStoreChallengeRequestSchema>;

export const LinkStoreChallengeSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  nonce: base64UrlOfLength(NONCE_BYTES),
  deadlineSeconds: z.number().int().min(1).max(LINK_STORE_CHALLENGE_SECONDS),
});
export type LinkStoreChallenge = z.infer<typeof LinkStoreChallengeSchema>;

const SignedFields = {
  daemonId: DaemonIdField,
  publicKey: base64UrlOfLength(ED25519_SPKI_BYTES),
  nonce: base64UrlOfLength(NONCE_BYTES),
  signature: base64UrlOfLength(ED25519_SIGNATURE_BYTES),
};

export const LINK_UPLOAD_ACTIONS = ['create', 'replace'] as const;
export const LinkUploadActionSchema = z.enum(LINK_UPLOAD_ACTIONS);
export type LinkUploadAction = z.infer<typeof LinkUploadActionSchema>;

/**
 * The JSON half of an upload. `installCap` is the store's to enforce and is NOT in the signed link
 * document, so changing it needs no re-sign; it is in the signed transcript, so nobody on the road can.
 */
export const LinkUploadMetadataSchema = z
  .strictObject({
    ...SignedFields,
    action: LinkUploadActionSchema,
    kind: CatalogLinkKindSchema,
    sequence: z.number().int().min(1).max(0xffffffff),
    /** Required for a replace: compare-and-swap against the stored sequence. */
    expectSequence: z.number().int().min(1).max(0xffffffff).optional(),
    notAfter: InstantSchema,
    expiresAt: InstantSchema.optional(),
    installCap: z.number().int().min(1).max(10_000).optional(),
    fetchVerifier: base64UrlOfLength(32),
    envelopeSha256: base64UrlOfLength(32),
    envelopeBytes: z.number().int().min(1).max(LINK_ENVELOPE_MAX_BYTES),
  })
  .check(ctx => {
    const upload = ctx.value;
    const issue = (message: string, path: string) =>
      ctx.issues.push({ code: 'custom', message, input: upload, path: [path] });
    if (upload.action === 'create' && upload.expectSequence !== undefined)
      issue('a create expects no earlier sequence', 'expectSequence');
    if (upload.action === 'replace') {
      if (upload.expectSequence === undefined) issue('a replace names the sequence it replaces', 'expectSequence');
      else if (upload.sequence <= upload.expectSequence) issue('a replace goes up', 'sequence');
      if (upload.kind !== 'public') issue('only a public link is replaced', 'kind');
    }
    if (upload.kind === 'one-time') {
      if (upload.sequence !== 1) issue('a one-time link is uploaded once', 'sequence');
      if (upload.installCap !== undefined) issue('a one-time link has no install cap', 'installCap');
    }
    if (upload.expiresAt !== undefined && Date.parse(upload.notAfter) > Date.parse(upload.expiresAt))
      issue('notAfter is after expiresAt', 'notAfter');
  });
export type LinkUploadMetadata = z.infer<typeof LinkUploadMetadataSchema>;

export const LinkDeleteRequestSchema = z.strictObject(SignedFields);
export type LinkDeleteRequest = z.infer<typeof LinkDeleteRequestSchema>;

export const LinkStatusRequestSchema = z.strictObject({
  ...SignedFields,
  bundleIds: z.array(LinkBundleIdSchema).min(1).max(LINK_STORE_STATUS_MAX_IDS),
});
export type LinkStatusRequest = z.infer<typeof LinkStatusRequestSchema>;

export const LINK_STORE_LINK_STATES = ['live', 'used', 'ended', 'lapsed', 'unknown'] as const;
export const LinkStoreLinkStateSchema = z.enum(LINK_STORE_LINK_STATES);
export type LinkStoreLinkState = z.infer<typeof LinkStoreLinkStateSchema>;

export const LinkStatusSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  links: z.array(
    z.strictObject({
      bundleId: LinkBundleIdSchema,
      state: LinkStoreLinkStateSchema,
      kind: CatalogLinkKindSchema.optional(),
      sequence: z.number().int().min(1).max(0xffffffff).optional(),
      opens: z.number().int().min(0).optional(),
      notAfter: InstantSchema.optional(),
      expiresAt: InstantSchema.optional(),
      installCap: z.number().int().min(1).optional(),
      storedBytes: z.number().int().min(0).optional(),
    }),
  ),
});
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

/** `POST …/peek` and `POST …/fetch` body. */
export const LinkFetchRequestSchema = z.strictObject({ token: base64UrlOfLength(32) });
export type LinkFetchRequest = z.infer<typeof LinkFetchRequestSchema>;

export const LinkPeekSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  kind: CatalogLinkKindSchema,
  expiresAt: InstantSchema.optional(),
});
export type LinkPeek = z.infer<typeof LinkPeekSchema>;

/** The headers a 200 fetch carries beside `Cache-Control: no-store`. */
export const LINK_KIND_HEADER = 'X-Ferretry-Link-Kind' as const;
export const LINK_SEQUENCE_HEADER = 'X-Ferretry-Link-Sequence' as const;

export const LINK_STORE_REFUSALS = [
  'link_store_unavailable',
  'link_store_capacity',
  'link_bad_request',
  'link_claim_rejected',
  'link_challenge_expired',
  'link_rate_limited',
  'link_store_full',
  'link_too_big',
  'link_exists',
  'link_sequence_conflict',
  'link_unknown',
  'link_gone',
] as const;
export const LinkStoreRefusalCodeSchema = z.enum(LINK_STORE_REFUSALS);
export type LinkStoreRefusalCode = z.infer<typeof LinkStoreRefusalCodeSchema>;

export const LinkStoreRefusalSchema = z.strictObject({
  error: z.strictObject({ code: LinkStoreRefusalCodeSchema, message: z.string().min(1).max(512) }),
});
export type LinkStoreRefusal = z.infer<typeof LinkStoreRefusalSchema>;

/** The HTTP status and the sentence each refusal carries. One place, so the Worker and a daemon agree. */
export const LINK_STORE_REFUSAL_DETAIL: Readonly<Record<LinkStoreRefusalCode, { status: number; message: string }>> = {
  link_store_unavailable: {
    status: 503,
    message: 'This link store is not taking requests right now. Try again later.',
  },
  link_store_capacity: { status: 503, message: 'This link store is full right now. Try again later.' },
  link_bad_request: { status: 400, message: 'The link store could not read that request.' },
  link_claim_rejected: { status: 401, message: 'The link store did not accept that signature.' },
  link_challenge_expired: { status: 401, message: 'That request was too slow or was already used. Ask for a new one.' },
  link_rate_limited: { status: 429, message: 'Too many requests. Wait a minute and try again.' },
  link_store_full: { status: 409, message: 'This machine already has as many links as the link store allows.' },
  link_too_big: { status: 413, message: 'This is too large to share as a link. Export it as a file instead.' },
  link_exists: { status: 409, message: 'The link store already has a link with that id.' },
  link_sequence_conflict: { status: 409, message: 'The link changed since it was last read.' },
  link_unknown: { status: 404, message: 'The link store does not know that link.' },
  link_gone: { status: 410, message: LINK_GONE_SENTENCE },
};

/** The body of a refusal, spelled one way so two refusals with the same code are the same bytes. */
export function linkStoreRefusalBody(code: LinkStoreRefusalCode): string {
  return JSON.stringify({ error: { code, message: LINK_STORE_REFUSAL_DETAIL[code].message } });
}

// ── The bytes a signature covers ─────────────────────────────────────────────────────────────────

/** Why: `body` carries only what the action signs, so a field cannot be added to a request and escape the signature. */
export type LinkStoreRequestBody =
  | {
      readonly request: 'upload';
      readonly bundleId: string;
      readonly action: LinkUploadAction;
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

export interface SignedLinkStoreRequest {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

/** The daemon half: sign one request with the identity pairing minted. */
export async function signLinkStoreRequest(
  crypto: RelayCrypto,
  identity: DaemonIdentity,
  context: LinkStoreRequestContext,
): Promise<SignedLinkStoreRequest> {
  const signature = await crypto.signEd25519(identity.privateKey, linkStoreTranscript(context));
  return {
    daemonId: context.daemonId,
    publicKey: toBase64Url(identity.publicKeySpki),
    nonce: toBase64Url(context.nonce),
    signature: toBase64Url(signature),
  };
}

export type LinkStoreRequestVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The store half. Accepts only if the key hashes to the fingerprint AND the signature verifies over the
 * transcript the STORE rebuilds from its own host, its own outstanding nonce and the request it parsed.
 */
export async function verifyLinkStoreRequest(
  crypto: RelayCrypto,
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

/** The signed body of a parsed upload: only the fields the transcript covers. */
export function linkUploadSignedBody(bundleId: string, metadata: LinkUploadMetadata): LinkStoreRequestBody {
  return {
    request: 'upload',
    bundleId,
    action: metadata.action,
    kind: metadata.kind,
    sequence: metadata.sequence,
    ...(metadata.expectSequence === undefined ? {} : { expectSequence: metadata.expectSequence }),
    notAfter: metadata.notAfter,
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    ...(metadata.installCap === undefined ? {} : { installCap: metadata.installCap }),
    fetchVerifier: metadata.fetchVerifier,
    envelopeSha256: metadata.envelopeSha256,
    envelopeBytes: metadata.envelopeBytes,
  };
}

// ── The upload body ──────────────────────────────────────────────────────────────────────────────

/** `uint32be N ‖ N bytes of UTF-8 JSON metadata ‖ envelope bytes`, `application/octet-stream`. */
export function encodeLinkUploadBody(metadata: LinkUploadMetadata, envelope: Uint8Array): Uint8Array {
  const json = utf8Bytes(JSON.stringify(metadata));
  const prefix = new Uint8Array(4);
  writeUint32(prefix, 0, json.length);
  return concatBytes([prefix, json, envelope]);
}

export type LinkUploadBodyResult =
  | { readonly ok: true; readonly metadata: LinkUploadMetadata; readonly envelope: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_big' | 'malformed' };

/**
 * Read an upload body: bounded before it is parsed, and the envelope checked against the length and the
 * SHA-256 the metadata (and so the signature) names. A mismatch of either refuses the upload.
 */
export async function decodeLinkUploadBody(crypto: RelayCrypto, bytes: Uint8Array): Promise<LinkUploadBodyResult> {
  if (bytes.length > LINK_UPLOAD_METADATA_MAX_BYTES + 4 + LINK_ENVELOPE_MAX_BYTES)
    return { ok: false, reason: 'too_big' };
  if (bytes.length < 4) return { ok: false, reason: 'malformed' };
  const length = readUint32(bytes, 0);
  if (length < 2 || length > LINK_UPLOAD_METADATA_MAX_BYTES || 4 + length > bytes.length)
    return { ok: false, reason: 'malformed' };
  const text = utf8Text(bytes.subarray(4, 4 + length));
  if (text === null) return { ok: false, reason: 'malformed' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = LinkUploadMetadataSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const envelope = bytes.subarray(4 + length);
  if (envelope.length !== parsed.data.envelopeBytes) return { ok: false, reason: 'malformed' };
  if (toBase64Url(await crypto.sha256(envelope)) !== parsed.data.envelopeSha256)
    return { ok: false, reason: 'malformed' };
  return { ok: true, metadata: parsed.data, envelope };
}
