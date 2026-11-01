/**
 * THE DAEMON'S HALF OF A WEBAUTHN CEREMONY: deciding whether a passkey registration or assertion is
 * genuine (`docs/design/zero-trust.md` B2).
 *
 * The browser performs the ceremony; the daemon verifies it. This module checks everything that is
 * a property of the bytes — the clientData type, challenge and origin, the relying-party hash, the
 * UP and UV flags, the attested public key, the signature and the counter — in the order the design
 * fixes. What is a property of daemon state is the caller's: that the challenge was issued to this
 * device and `appSession`, is unexpired and unspent, and that the credential belongs to this device.
 *
 * A STORED proof (a standing sign-in rule's) is checked again later by {@link verifyStoredAssertion}: the same checks
 * but the counter, against the passkey's own origin. It is never a live ceremony.
 *
 * Every check is total. A malformed input is `{ ok: false, reason: 'malformed' }`, never a throw, and
 * a refusal is one of a closed set of reasons that never carries an input value — so nothing a
 * caller logs or answers can echo a challenge, a signature or a key.
 */

import { bytesEqual, concatBytes, fromBase64Url, utf8Bytes, utf8Text } from '@ferretry/relay';
import { decodeCbor, decodeCborItem, isCborMap } from './cbor.ts';
import { coseKeyToSpki, derSignatureToRaw, ES256, type PasskeyAlgorithm } from './keys.ts';

/** What the verifier needs from WebCrypto, injected so this library stays pure. */
export interface PasskeyCrypto {
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Verify a signature by a COSE-derived public key. `algorithm` is the COSE alg: -7 (ES256), -8
   * (EdDSA/Ed25519), -257 (RS256). For ES256 the signature arrives DER-encoded and the port is
   * handed the RAW r||s form (the verifier converts).
   */
  verify(algorithm: PasskeyAlgorithm, spki: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

export interface RegistrationInput {
  readonly clientDataJSON: Uint8Array;
  readonly attestationObject: Uint8Array;
  /** The challenge the daemon issued. */
  readonly expectedChallenge: Uint8Array;
  /** The daemon's `corsOrigins`; `clientData.origin` must equal one exactly. */
  readonly allowedOrigins: readonly string[];
}

export type RegistrationResult =
  | {
      readonly ok: true;
      readonly credentialId: Uint8Array;
      readonly algorithm: PasskeyAlgorithm;
      readonly publicKeySpki: Uint8Array;
      readonly signCount: number;
      readonly origin: string;
    }
  | { readonly ok: false; readonly reason: PasskeyRefusal };

export interface AssertionInput {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  readonly expectedChallenge: Uint8Array;
  readonly allowedOrigins: readonly string[];
  readonly credential: {
    readonly algorithm: PasskeyAlgorithm;
    readonly publicKeySpki: Uint8Array;
    readonly signCount: number;
  };
}

export type AssertionResult =
  | { readonly ok: true; readonly signCount: number; readonly origin: string }
  | { readonly ok: false; readonly reason: PasskeyRefusal };

/** A closed set of machine reasons; never carries an input value. */
export type PasskeyRefusal =
  | 'malformed'
  | 'wrong-type'
  | 'challenge-mismatch'
  | 'origin-not-allowed'
  | 'rp-id-mismatch'
  | 'user-not-present'
  | 'user-not-verified'
  | 'unsupported-algorithm'
  | 'bad-signature'
  | 'counter-not-increased'
  | 'attestation-unsupported';

/** Input bounds: far above anything a real authenticator sends, far below anything that costs. */
export const PASSKEY_LIMITS = {
  clientDataJSON: 4096,
  attestationObject: 16 * 1024,
  authenticatorData: 4096,
  credentialId: 1023,
  signature: 1024,
} as const;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
/** rpIdHash (32) ‖ flags (1) ‖ signCount (4). */
const AUTH_DATA_HEADER = 37;
const AAGUID_BYTES = 16;

type Refusal = { readonly ok: false; readonly reason: PasskeyRefusal };

function refuse(reason: PasskeyRefusal): Refusal {
  return { ok: false, reason };
}

/** rpId for an allowed origin: its hostname (WebAuthn's default rpId). */
export function relyingPartyId(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).hostname : '';
}

/** Verify a `navigator.credentials.create()` result and extract the credential to store. */
export async function verifyRegistration(crypto: PasskeyCrypto, input: RegistrationInput): Promise<RegistrationResult> {
  if (
    input.clientDataJSON.length > PASSKEY_LIMITS.clientDataJSON ||
    input.attestationObject.length > PASSKEY_LIMITS.attestationObject
  ) {
    return refuse('malformed');
  }
  const client = checkClientData(
    input.clientDataJSON,
    'webauthn.create',
    input.expectedChallenge,
    input.allowedOrigins,
  );
  if (!client.ok) return client;
  const attestation = decodeCbor(input.attestationObject);
  if (!isCborMap(attestation)) return refuse('malformed');
  const format = attestation.get('fmt');
  const authData = attestation.get('authData');
  if (typeof format !== 'string' || !(authData instanceof Uint8Array) || !isCborMap(attestation.get('attStmt'))) {
    return refuse('malformed');
  }
  if (authData.length > PASSKEY_LIMITS.authenticatorData) return refuse('malformed');
  const header = await checkAuthenticatorData(crypto, authData, client.origin);
  if (!header.ok) return header;
  if ((header.flags & FLAG_ATTESTED_CREDENTIAL) === 0) return refuse('malformed');
  // `none` carries no statement and `packed` carries one this verifier does not check: it trusts the
  // credential because the person proved presence and verification to their own authenticator, not
  // because a vendor certificate chain vouched for the hardware. Other formats are refused rather
  // than treated as `none`, so accepting one later is a deliberate change.
  if (format !== 'none' && format !== 'packed') return refuse('attestation-unsupported');
  const credentialIdLength =
    ((authData[AUTH_DATA_HEADER + AAGUID_BYTES] ?? 0) << 8) | (authData[AUTH_DATA_HEADER + AAGUID_BYTES + 1] ?? 0);
  const credentialIdStart = AUTH_DATA_HEADER + AAGUID_BYTES + 2;
  const credentialIdEnd = credentialIdStart + credentialIdLength;
  if (
    credentialIdLength === 0 ||
    credentialIdLength > PASSKEY_LIMITS.credentialId ||
    credentialIdEnd >= authData.length
  ) {
    return refuse('malformed');
  }
  const coseKey = decodeCborItem(authData, credentialIdEnd);
  // Extensions (the ED flag) would follow the key; a registration never asks for any, so none may.
  if (coseKey === undefined || coseKey.end !== authData.length) return refuse('malformed');
  const key = coseKeyToSpki(coseKey.value);
  if (!key.ok) return refuse(key.reason);
  return {
    ok: true,
    credentialId: authData.slice(credentialIdStart, credentialIdEnd),
    algorithm: key.algorithm,
    publicKeySpki: key.spki,
    signCount: header.signCount,
    origin: client.origin,
  };
}

/** Verify a `navigator.credentials.get()` result against a credential the daemon already stores. */
export async function verifyAssertion(crypto: PasskeyCrypto, input: AssertionInput): Promise<AssertionResult> {
  if (
    input.clientDataJSON.length > PASSKEY_LIMITS.clientDataJSON ||
    input.authenticatorData.length > PASSKEY_LIMITS.authenticatorData ||
    input.signature.length > PASSKEY_LIMITS.signature
  ) {
    return refuse('malformed');
  }
  const client = checkClientData(input.clientDataJSON, 'webauthn.get', input.expectedChallenge, input.allowedOrigins);
  if (!client.ok) return client;
  const header = await checkAuthenticatorData(crypto, input.authenticatorData, client.origin);
  if (!header.ok) return header;
  const { algorithm, publicKeySpki, signCount: storedCount } = input.credential;
  const signature = algorithm === ES256 ? derSignatureToRaw(input.signature) : input.signature;
  if (signature === undefined) return refuse('bad-signature');
  const signed = concatBytes([input.authenticatorData, await crypto.sha256(input.clientDataJSON)]);
  if (!(await verifySafely(crypto, algorithm, publicKeySpki, signature, signed))) return refuse('bad-signature');
  // An authenticator that keeps no counter reports zero forever; one that does must move forward,
  // because a counter that stalls or rewinds is the one sign a cloned authenticator leaves.
  if ((storedCount !== 0 || header.signCount !== 0) && header.signCount <= storedCount) {
    return refuse('counter-not-increased');
  }
  return { ok: true, signCount: header.signCount, origin: client.origin };
}

/**
 * A KEPT assertion, checked again later: the bytes exactly as the authenticator signed them, the challenge the daemon
 * derives again from what was approved, and the passkey it names as the registry holds it NOW.
 */
export interface StoredAssertionInput {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  readonly expectedChallenge: Uint8Array;
  readonly passkey: {
    readonly algorithm: PasskeyAlgorithm;
    readonly publicKeySpki: Uint8Array;
    /** The app origin the passkey was made at: the only origin its kept assertion may name. */
    readonly origin: string;
  };
}

/**
 * Checks a STORED assertion again, offline (`docs/design/zero-trust.md`, "Stored passkey proofs"): everything
 * {@link verifyAssertion} checks — `webauthn.get`, the challenge, the origin, the rpId hash, UP, UV and the signature —
 * except the counter.
 *
 * NEVER USE IT FOR A LIVE CEREMONY. The counter is the one sign a cloned authenticator leaves, and a live assertion must
 * move it; a kept one is the same bytes every time it is checked, so its counter can never move again. What makes the
 * missing counter safe here is the challenge: it is derived from the approved bytes, so a kept assertion verifies only
 * against exactly those bytes, and nothing that checks a stored proof ever grants a live step-up.
 *
 * The origin is the passkey's own, never the daemon's `corsOrigins`: a kept proof outlives any config change, and it
 * was made at exactly one origin.
 */
export async function verifyStoredAssertion(
  crypto: PasskeyCrypto,
  input: StoredAssertionInput,
): Promise<AssertionResult> {
  return await verifyAssertion(crypto, {
    clientDataJSON: input.clientDataJSON,
    authenticatorData: input.authenticatorData,
    signature: input.signature,
    expectedChallenge: input.expectedChallenge,
    allowedOrigins: [input.passkey.origin],
    // Zero stored, so any counter the authenticator reported passes: the counter is not checked offline.
    credential: { algorithm: input.passkey.algorithm, publicKeySpki: input.passkey.publicKeySpki, signCount: 0 },
  });
}

type ClientDataCheck = { readonly ok: true; readonly origin: string } | Refusal;

function checkClientData(
  bytes: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  expectedChallenge: Uint8Array,
  allowedOrigins: readonly string[],
): ClientDataCheck {
  const clientData = parseJsonObject(bytes);
  if (clientData === undefined) return refuse('malformed');
  if (clientData.type !== type) return refuse('wrong-type');
  const challenge = typeof clientData.challenge === 'string' ? fromBase64Url(clientData.challenge) : null;
  if (challenge === null || !bytesEqual(challenge, expectedChallenge)) return refuse('challenge-mismatch');
  const origin = clientData.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return refuse('origin-not-allowed');
  // A page framed by another origin is not the app asking; `crossOrigin: false` is simply ignored.
  if (clientData.crossOrigin === true) return refuse('origin-not-allowed');
  return { ok: true, origin };
}

type HeaderCheck = { readonly ok: true; readonly flags: number; readonly signCount: number } | Refusal;

async function checkAuthenticatorData(
  crypto: PasskeyCrypto,
  authData: Uint8Array,
  origin: string,
): Promise<HeaderCheck> {
  if (authData.length < AUTH_DATA_HEADER) return refuse('malformed');
  const rpIdHash = await crypto.sha256(utf8Bytes(relyingPartyId(origin)));
  if (!bytesEqual(authData.subarray(0, 32), rpIdHash)) return refuse('rp-id-mismatch');
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0) return refuse('user-not-present');
  if ((flags & FLAG_USER_VERIFIED) === 0) return refuse('user-not-verified');
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
  return { ok: true, flags, signCount };
}

/** A port that rejects (an unimportable key, say) is a signature that did not verify. */
async function verifySafely(
  crypto: PasskeyCrypto,
  algorithm: PasskeyAlgorithm,
  spki: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    return await crypto.verify(algorithm, spki, signature, data);
  } catch {
    return false;
  }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  const text = utf8Text(bytes);
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
