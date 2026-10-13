/**
 * A software authenticator for the passkey verifier's tests: real WebCrypto key pairs, a hand-written
 * CBOR encoder, and authenticatorData and attestation objects laid out byte for byte as an
 * authenticator lays them out (WebAuthn §6.1, §6.5). Nothing here is mocked; a fixture that verifies
 * does so because the bytes are right.
 */

import { concatBytes, fromBase64Url, toBase64Url, utf8Bytes } from '@ferretry/relay';
import type { PasskeyAlgorithm, PasskeyCrypto } from '../../src/lib/passkeys/index.ts';

export const ORIGIN = 'https://ferretry.pages.dev';
const RP_ID = 'ferretry.pages.dev';
export const CHALLENGE = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff);

/** A CBOR item to encode; `Tagged` writes a raw prefix so tests can hand-craft refusals. */
export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  if (value < 0x10000) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  );
}

/** Canonical-enough CBOR: definite lengths, shortest heads, keys in insertion order. */
export function cbor(value: Cbor): Uint8Array {
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = utf8Bytes(value);
    return concatBytes([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return concatBytes([head(2, value.length), value]);
  if (Array.isArray(value)) return concatBytes([head(4, value.length), ...value.map(cbor)]);
  const parts: Uint8Array[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return concatBytes(parts);
}

export interface Authenticator {
  readonly algorithm: PasskeyAlgorithm;
  readonly coseKey: Map<number | string, Cbor>;
  /** What the platform exports, to prove the verifier's COSE→SPKI translation byte for byte. */
  readonly spki: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
};

const b64 = (text: string | undefined): Uint8Array => fromBase64Url(text ?? '') ?? new Uint8Array();

/** DER `SEQUENCE { INTEGER r, INTEGER s }` from raw r‖s, exactly as an ES256 authenticator emits it. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < half.length - 1 && half[start] === 0) start += 1;
    let body = half.subarray(start);
    if (((body[0] ?? 0) & 0x80) !== 0) body = concatBytes([Uint8Array.of(0), body]);
    return concatBytes([Uint8Array.of(0x02, body.length), body]);
  };
  const content = concatBytes([integer(raw.subarray(0, 32)), integer(raw.subarray(32))]);
  return concatBytes([Uint8Array.of(0x30, content.length), content]);
}

export async function es256Authenticator(): Promise<
  Authenticator & { signRaw(data: Uint8Array): Promise<Uint8Array> }
> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const signRaw = async (data: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, owned(data)));
  return {
    algorithm: -7,
    coseKey: new Map<number | string, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, b64(jwk.x)],
      [-3, b64(jwk.y)],
    ]),
    spki: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    signRaw,
    sign: async data => rawToDer(await signRaw(data)),
  };
}

export async function ed25519Authenticator(): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return {
    algorithm: -8,
    coseKey: new Map<number | string, Cbor>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))],
    ]),
    spki: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    sign: async data => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, owned(data))),
  };
}

export async function rs256Authenticator(modulusLength = 2048): Promise<Authenticator> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    algorithm: -257,
    coseKey: new Map<number | string, Cbor>([
      [1, 3],
      [3, -257],
      [-1, b64(jwk.n)],
      [-2, b64(jwk.e)],
    ]),
    spki: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    sign: async data =>
      new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, owned(data))),
  };
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', owned(bytes)));
}

/** The real WebCrypto port, written inline so the unit tier needs no adapter. */
export const webCrypto: PasskeyCrypto = {
  sha256,
  async verify(algorithm: PasskeyAlgorithm, spki: Uint8Array, signature: Uint8Array, data: Uint8Array) {
    const imports = {
      [-7]: { name: 'ECDSA', namedCurve: 'P-256' },
      [-8]: { name: 'Ed25519' },
      [-257]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    } as const;
    const verifies = {
      [-7]: { name: 'ECDSA', hash: 'SHA-256' },
      [-8]: { name: 'Ed25519' },
      [-257]: { name: 'RSASSA-PKCS1-v1_5' },
    } as const;
    const key = await crypto.subtle.importKey('spki', owned(spki), imports[algorithm], false, ['verify']);
    return crypto.subtle.verify(verifies[algorithm], key, owned(signature), owned(data));
  },
};

export interface ClientDataFields {
  type?: unknown;
  challenge?: unknown;
  origin?: unknown;
  crossOrigin?: unknown;
}

export function clientData(type: string, fields: ClientDataFields = {}): Uint8Array {
  return utf8Bytes(
    JSON.stringify({ type, challenge: toBase64Url(CHALLENGE), origin: ORIGIN, crossOrigin: false, ...fields }),
  );
}

export interface AuthDataFields {
  rpId?: string;
  flags?: number;
  signCount?: number;
  /** Attested credential data appended after the header (registration only). */
  attested?: Uint8Array;
}

export async function authData(fields: AuthDataFields = {}): Promise<Uint8Array> {
  const header = new Uint8Array(37);
  header.set(await sha256(utf8Bytes(fields.rpId ?? RP_ID)), 0);
  header[32] = fields.flags ?? 0x05;
  new DataView(header.buffer).setUint32(33, fields.signCount ?? 0, false);
  return concatBytes([header, fields.attested ?? new Uint8Array()]);
}

export const CREDENTIAL_ID = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);

/** aaguid (16) ‖ credIdLen (u16 BE) ‖ credId ‖ COSE_Key. */
export function attestedCredential(coseKey: Uint8Array, credentialId: Uint8Array = CREDENTIAL_ID): Uint8Array {
  return concatBytes([
    new Uint8Array(16),
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    coseKey,
  ]);
}

export function attestationObject(auth: Uint8Array, fmt: Cbor = 'none', attStmt: Cbor = new Map()): Uint8Array {
  return cbor(
    new Map<number | string, Cbor>([
      ['fmt', fmt],
      ['attStmt', attStmt],
      ['authData', auth],
    ]),
  );
}

/** A full, valid registration for one authenticator; every field is overridable. */
export async function registration(
  authenticator: Authenticator,
  overrides: { client?: Uint8Array; auth?: AuthDataFields; fmt?: Cbor; attStmt?: Cbor } = {},
) {
  const auth = await authData({
    flags: 0x45,
    attested: attestedCredential(cbor(authenticator.coseKey)),
    ...overrides.auth,
  });
  return {
    clientDataJSON: overrides.client ?? clientData('webauthn.create'),
    attestationObject: attestationObject(auth, overrides.fmt, overrides.attStmt),
    expectedChallenge: CHALLENGE,
    allowedOrigins: [ORIGIN],
  };
}

/** A full, valid assertion for one authenticator, signed over authData ‖ SHA-256(clientDataJSON). */
export async function assertion(
  authenticator: Authenticator,
  overrides: { client?: Uint8Array; auth?: AuthDataFields; storedCount?: number } = {},
) {
  const clientDataJSON = overrides.client ?? clientData('webauthn.get');
  const authenticatorData = await authData({ signCount: 1, ...overrides.auth });
  const signature = await authenticator.sign(concatBytes([authenticatorData, await sha256(clientDataJSON)]));
  return {
    clientDataJSON,
    authenticatorData,
    signature,
    expectedChallenge: CHALLENGE,
    allowedOrigins: [ORIGIN],
    credential: {
      algorithm: authenticator.algorithm,
      publicKeySpki: authenticator.spki,
      signCount: overrides.storedCount ?? 0,
    },
  };
}
