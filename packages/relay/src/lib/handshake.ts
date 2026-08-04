/**
 * The end-to-end handshake, identical on every carrier.
 *
 * Shape, in one line: ephemeral X25519 on both sides for forward secrecy, an Ed25519 signature by
 * the daemon over the whole transcript for identity, and the client's own credential sent only
 * afterwards, inside the encrypted channel. That is the TLS 1.3 arrangement, and it is chosen for
 * the same reason TLS chose it — a signed transcript is what stops a party in the middle from
 * splicing two halves of two different conversations together.
 *
 * What a rendezvous can do to this: nothing that helps it. It can drop the conversation, delay it,
 * or refuse to carry it. It cannot substitute a key, because the client checks the presented key
 * against the fingerprint the pairing QR gave it out of band. It cannot read the client credential,
 * because that never appears until after the channel is keyed. It cannot inject a byte, because
 * every record is authenticated under a key it cannot derive.
 *
 * What it can still see is stated plainly in the protocol document: who is talking to whom, when,
 * how often and how big each frame is.
 */

import { z } from 'zod';
import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes, utf8Text } from './binary.ts';
import {
  AEAD_KEY_BYTES,
  CLIENT_TO_DAEMON_KEY_LABEL,
  DAEMON_TO_CLIENT_KEY_LABEL,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_BYTES,
  HANDSHAKE_SIGNATURE_LABEL,
  HANDSHAKE_TRANSCRIPT_LABEL,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
  X25519_PUBLIC_KEY_BYTES,
} from './constants.ts';
import type { DaemonIdentity, EphemeralKeyPair, RelayCrypto } from './crypto.ts';
import type { SessionId } from './frames.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

const base64Url = (byteLength: number): z.ZodString =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, 'not base64url')
    .length(Math.ceil((byteLength * 4) / 3), 'wrong encoded length');

/** Client → daemon. Names the daemon it believes it reached, so a misrouted session fails loudly. */
export const ClientHelloSchema = z.strictObject({
  t: z.literal('hs1'),
  protocol: z.literal(RELAY_PROTOCOL_ID),
  epk: base64Url(X25519_PUBLIC_KEY_BYTES),
  nonce: base64Url(NONCE_BYTES),
  daemonId: z.string().min(1).max(64),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

/** Daemon → client. The signature covers the transcript, not just the key, and not just the nonce. */
export const DaemonHelloSchema = z.strictObject({
  t: z.literal('hs2'),
  protocol: z.literal(RELAY_PROTOCOL_ID),
  epk: base64Url(X25519_PUBLIC_KEY_BYTES),
  nonce: base64Url(NONCE_BYTES),
  spki: base64Url(ED25519_SPKI_BYTES),
  sig: base64Url(ED25519_SIGNATURE_BYTES),
});
export type DaemonHello = z.infer<typeof DaemonHelloSchema>;

export function encodeHandshakeMessage(message: ClientHello | DaemonHello): Uint8Array {
  return utf8Bytes(JSON.stringify(message));
}

function decodeJson(payload: Uint8Array): unknown {
  const text = utf8Text(payload);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function decodeClientHello(payload: Uint8Array): ClientHello | null {
  const parsed = ClientHelloSchema.safeParse(decodeJson(payload));
  return parsed.success ? parsed.data : null;
}

export function decodeDaemonHello(payload: Uint8Array): DaemonHello | null {
  const parsed = DaemonHelloSchema.safeParse(decodeJson(payload));
  return parsed.success ? parsed.data : null;
}

/**
 * The transcript hash.
 *
 * Every field either side chose is in it, length-prefixed, including the session identifier the
 * carrier assigned. Binding the session identifier is what stops a rendezvous from replaying one
 * conversation's opening into a different session it also carries.
 */
export async function handshakeTranscriptHash(
  crypto: RelayCrypto,
  sessionId: SessionId,
  clientHello: ClientHello,
  daemonHello: Omit<DaemonHello, 'sig'>,
): Promise<Uint8Array> {
  return crypto.sha256(
    concatBytes([
      utf8Bytes(HANDSHAKE_TRANSCRIPT_LABEL),
      lengthPrefixed(sessionId.bytes),
      lengthPrefixed(utf8Bytes(clientHello.epk)),
      lengthPrefixed(utf8Bytes(clientHello.nonce)),
      lengthPrefixed(utf8Bytes(clientHello.daemonId)),
      lengthPrefixed(utf8Bytes(daemonHello.epk)),
      lengthPrefixed(utf8Bytes(daemonHello.nonce)),
      lengthPrefixed(utf8Bytes(daemonHello.spki)),
    ]),
  );
}

function signedTranscript(transcriptHash: Uint8Array): Uint8Array {
  return concatBytes([utf8Bytes(HANDSHAKE_SIGNATURE_LABEL), new Uint8Array([0]), transcriptHash]);
}

/** The two directional record keys, plus the transcript hash both sides can compare. */
export interface SessionKeys {
  readonly clientToDaemon: Uint8Array;
  readonly daemonToClient: Uint8Array;
  readonly transcriptHash: Uint8Array;
}

async function deriveSessionKeys(
  crypto: RelayCrypto,
  sharedSecret: Uint8Array,
  transcriptHash: Uint8Array,
): Promise<SessionKeys> {
  const [clientToDaemon, daemonToClient] = await Promise.all([
    crypto.deriveKey(sharedSecret, transcriptHash, CLIENT_TO_DAEMON_KEY_LABEL, AEAD_KEY_BYTES),
    crypto.deriveKey(sharedSecret, transcriptHash, DAEMON_TO_CLIENT_KEY_LABEL, AEAD_KEY_BYTES),
  ]);
  return { clientToDaemon, daemonToClient, transcriptHash };
}

// ─── client side ──────────────────────────────────────────────────────────────────────────────

export interface PendingClientHandshake {
  readonly hello: ClientHello;
  readonly ephemeral: EphemeralKeyPair;
  readonly sessionId: SessionId;
  /** The fingerprint the pairing QR supplied. Nothing else is accepted in its place. */
  readonly expectedDaemonId: string;
}

/** Begin a handshake against a daemon the caller already knows the fingerprint of. */
export async function startClientHandshake(
  crypto: RelayCrypto,
  sessionId: SessionId,
  expectedDaemonId: string,
): Promise<PendingClientHandshake> {
  const ephemeral = await crypto.generateEphemeralKeyPair();
  const hello: ClientHello = {
    t: 'hs1',
    protocol: RELAY_PROTOCOL_ID,
    epk: toBase64Url(ephemeral.publicKey),
    nonce: toBase64Url(crypto.randomBytes(NONCE_BYTES)),
    daemonId: expectedDaemonId,
  };
  return { hello, ephemeral, sessionId, expectedDaemonId };
}

export type ClientHandshakeResult =
  | { readonly ok: true; readonly keys: SessionKeys; readonly daemonPublicKeySpki: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/**
 * Finish the client half.
 *
 * The order of the checks is the security argument. The fingerprint is checked before the
 * signature, and both before any key is derived, so a wrong daemon is refused without ever
 * reaching a state where the caller holds usable keys.
 */
export async function completeClientHandshake(
  crypto: RelayCrypto,
  pending: PendingClientHandshake,
  daemonHello: DaemonHello,
): Promise<ClientHandshakeResult> {
  const spki = fromBase64UrlFixed(daemonHello.spki, ED25519_SPKI_BYTES);
  const signature = fromBase64UrlFixed(daemonHello.sig, ED25519_SIGNATURE_BYTES);
  const peerPublicKey = fromBase64UrlFixed(daemonHello.epk, X25519_PUBLIC_KEY_BYTES);
  if (spki === null || signature === null || peerPublicKey === null) {
    return { ok: false, reason: 'daemon hello carries malformed key material' };
  }
  if (!(await publicKeyMatchesDaemonId(crypto, spki, pending.expectedDaemonId))) {
    return { ok: false, reason: 'daemon key does not match the pinned fingerprint' };
  }

  const transcriptHash = await handshakeTranscriptHash(crypto, pending.sessionId, pending.hello, daemonHello);
  if (!(await crypto.verifyEd25519(spki, signature, signedTranscript(transcriptHash)))) {
    return { ok: false, reason: 'daemon signature does not cover this handshake' };
  }

  const sharedSecret = await crypto.deriveSharedSecret(pending.ephemeral.privateKey, peerPublicKey);
  if (sharedSecret === null) return { ok: false, reason: 'key agreement produced no usable secret' };

  return { ok: true, keys: await deriveSessionKeys(crypto, sharedSecret, transcriptHash), daemonPublicKeySpki: spki };
}

// ─── daemon side ──────────────────────────────────────────────────────────────────────────────

export type DaemonHandshakeResult =
  | { readonly ok: true; readonly hello: DaemonHello; readonly keys: SessionKeys }
  | { readonly ok: false; readonly reason: string };

/**
 * Answer a client hello.
 *
 * The daemon refuses a hello addressed to a different fingerprint. It cannot happen on a correct
 * carrier, which is the reason to check it: on an incorrect one it is a misrouted session, and
 * carrying on would key a channel to a peer that thinks it reached somebody else.
 */
export async function answerClientHandshake(
  crypto: RelayCrypto,
  identity: DaemonIdentity,
  sessionId: SessionId,
  clientHello: ClientHello,
): Promise<DaemonHandshakeResult> {
  if (clientHello.daemonId !== identity.daemonId) {
    return { ok: false, reason: 'client hello names a different daemon' };
  }
  const peerPublicKey = fromBase64UrlFixed(clientHello.epk, X25519_PUBLIC_KEY_BYTES);
  if (peerPublicKey === null) return { ok: false, reason: 'client hello carries a malformed ephemeral key' };

  const ephemeral = await crypto.generateEphemeralKeyPair();
  const unsigned = {
    t: 'hs2',
    protocol: RELAY_PROTOCOL_ID,
    epk: toBase64Url(ephemeral.publicKey),
    nonce: toBase64Url(crypto.randomBytes(NONCE_BYTES)),
    spki: toBase64Url(identity.publicKeySpki),
  } as const;

  const sharedSecret = await crypto.deriveSharedSecret(ephemeral.privateKey, peerPublicKey);
  if (sharedSecret === null) return { ok: false, reason: 'key agreement produced no usable secret' };

  const transcriptHash = await handshakeTranscriptHash(crypto, sessionId, clientHello, unsigned);
  const signature = await crypto.signEd25519(identity.privateKey, signedTranscript(transcriptHash));

  return {
    ok: true,
    hello: { ...unsigned, sig: toBase64Url(signature) },
    keys: await deriveSessionKeys(crypto, sharedSecret, transcriptHash),
  };
}
