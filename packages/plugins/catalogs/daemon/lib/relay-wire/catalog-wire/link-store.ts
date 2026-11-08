/* TODO(kernel contract): temporary byte-copy until the pure kernel wire exports land. */
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
import { CatalogLinkKindSchema, LinkBundleIdSchema } from '../../../../contract/wire/index.ts';
import { InstantSchema } from '../../../../contract/wire/foreign.ts';
import { z } from 'zod';
import {
  concatBytes,
  fromBase64UrlFixed,
  lengthPrefixed,
  toBase64Url,
  utf8Bytes,
  writeUint32,
} from '../kernel-wire/index.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES, NONCE_BYTES } from '../kernel-wire/index.ts';
import type { DaemonIdentity, SessionCrypto } from '../kernel-wire/index.ts';
import { parseDaemonId } from '../kernel-wire/index.ts';
import { LINK_ENVELOPE_MAX_BYTES } from './link-bundle.ts';

const LINK_STORE_PROTOCOL_ID = 'ferretry-link-store/1' as const;
const LINK_STORE_VERSION = 1 as const;

/** `GET`, public, no-store, CORS `*`: whether this store takes new links at all. */
export const LINK_STORE_SERVICE_PATH = '/v1/link-store' as const;
/** `POST`: mints a single-use nonce a signed request must carry. */
export const LINK_STORE_CHALLENGE_PATH = '/v1/link-store/challenge' as const;
/** `POST`, signed: the state of up to 64 of the caller's links. */
export const LINK_STORE_STATUS_PATH = '/v1/link-store/status' as const;
/** `PUT` uploads or replaces one link, `DELETE` ends it. Both signed. */
export const linkBundlePath = (bundleId: string): string => `/v1/links/${bundleId}`;
/** Signature labels, one per action, each ended by the length prefix of the first field after it. */
export const LINK_STORE_UPLOAD_LABEL = 'ferretry-link-store-upload-v1' as const;
export const LINK_STORE_DELETE_LABEL = 'ferretry-link-store-delete-v1' as const;
export const LINK_STORE_STATUS_LABEL = 'ferretry-link-store-status-v1' as const;

/** How long a challenge nonce may be signed and spent. It is single-use within that window. */
const LINK_STORE_CHALLENGE_SECONDS = 60;
/** The one sentence every failed peek or fetch carries, whatever the cause. */
const LINK_GONE_SENTENCE =
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
export const LinkStoreChallengeSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  nonce: base64UrlOfLength(NONCE_BYTES),
  deadlineSeconds: z.number().int().min(1).max(LINK_STORE_CHALLENGE_SECONDS),
});
const SignedFields = {
  daemonId: DaemonIdField,
  publicKey: base64UrlOfLength(ED25519_SPKI_BYTES),
  nonce: base64UrlOfLength(NONCE_BYTES),
  signature: base64UrlOfLength(ED25519_SIGNATURE_BYTES),
};

const LINK_UPLOAD_ACTIONS = ['create', 'replace'] as const;
const LinkUploadActionSchema = z.enum(LINK_UPLOAD_ACTIONS);
type LinkUploadAction = z.infer<typeof LinkUploadActionSchema>;

/**
 * The JSON half of an upload. `installCap` is the store's to enforce and is NOT in the signed link
 * document, so changing it needs no re-sign; it is in the signed transcript, so nobody on the road can.
 */
const LinkUploadMetadataSchema = z
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

const LINK_STORE_LINK_STATES = ['live', 'used', 'ended', 'lapsed', 'unknown'] as const;
const LinkStoreLinkStateSchema = z.enum(LINK_STORE_LINK_STATES);
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

const LINK_STORE_REFUSALS = [
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
const LinkStoreRefusalCodeSchema = z.enum(LINK_STORE_REFUSALS);
export type LinkStoreRefusalCode = z.infer<typeof LinkStoreRefusalCodeSchema>;

export const LinkStoreRefusalSchema = z.strictObject({
  error: z.strictObject({ code: LinkStoreRefusalCodeSchema, message: z.string().min(1).max(512) }),
});
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
function linkStoreTranscript(context: LinkStoreRequestContext): Uint8Array {
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
  crypto: SessionCrypto,
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

// ── The upload body ──────────────────────────────────────────────────────────────────────────────

/** `uint32be N ‖ N bytes of UTF-8 JSON metadata ‖ envelope bytes`, `application/octet-stream`. */
export function encodeLinkUploadBody(metadata: LinkUploadMetadata, envelope: Uint8Array): Uint8Array {
  const json = utf8Bytes(JSON.stringify(metadata));
  const prefix = new Uint8Array(4);
  writeUint32(prefix, 0, json.length);
  return concatBytes([prefix, json, envelope]);
}
