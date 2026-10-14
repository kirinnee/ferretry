/**
 * THE BROWSER'S HALF OF A PASSKEY CEREMONY (`docs/design/zero-trust.md` B2).
 *
 * The browser performs the WebAuthn ceremony and the daemon verifies it. This module turns the
 * daemon's options (JSON, binary fields as base64url) into the `navigator.credentials` call, and the
 * credential that comes back into the JSON the daemon verifies. It decides nothing about trust: it
 * asks for user verification because the daemon refuses an assertion without UV, not because this
 * side could enforce it.
 *
 * It is pure over an injected {@link CredentialsPort} so every outcome — a credential, a dismissal,
 * a refusal by origin, a browser without passkeys — is a test rather than a hope.
 *
 * FAILURES ARE SENTENCES. A browser reports a dismissed prompt, a timeout and "no passkey matched"
 * as the same `NotAllowedError`, on purpose (telling them apart would reveal which credentials exist).
 * So `cancelled` covers all three honestly, and no raw DOMException name reaches a person.
 */

import { fromBase64Url, toBase64Url } from '@ferretry/relay';

/** The slice of `navigator.credentials` a ceremony needs. */
export interface CredentialsPort {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

/** The daemon's registration options, as JSON (base64url strings). */
export interface RegistrationOptionsWire {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout?: number;
  excludeCredentials?: { type: 'public-key'; id: string }[];
  /** Present when this device already holds a passkey: it must answer this assertion first. */
  confirm?: AssertionOptionsWire;
}

/** What goes back to the daemon after a registration. */
export interface RegistrationWire {
  credentialId: string;
  clientDataJSON: string;
  attestationObject: string;
  /** The assertion that answered the options' `confirm`, when they carried one. */
  confirmation?: AssertionWire;
}

/** The daemon's step-up options, as JSON (base64url strings). */
export interface AssertionOptionsWire {
  challenge: string;
  rpId: string;
  allowCredentials: { type: 'public-key'; id: string }[];
  timeout?: number;
}

/** What goes back to the daemon after a step-up. */
export interface AssertionWire {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

type CeremonyKind = 'no-passkey' | 'cancelled' | 'unsupported' | 'insecure-origin';

/**
 * A ceremony that did not produce a credential, by kind. Its message names the kind only; the
 * sentence a person reads is {@link passkeySentence}, which needs the app origin this module does
 * not know.
 */
export class PasskeyCeremonyError extends Error {
  readonly kind: CeremonyKind;

  constructor(kind: CeremonyKind) {
    super(`The passkey ceremony ended without a credential (${kind}).`);
    this.name = 'PasskeyCeremonyError';
    this.kind = kind;
  }
}

/** The plain sentence for a failed ceremony at `origin`, the app's own origin. */
export function passkeySentence(kind: PasskeyCeremonyError['kind'], origin: string): string {
  switch (kind) {
    case 'no-passkey':
      return `This copy of the app at ${origin} has no passkey for this machine. Add one from a device that already has access, or ask the owner to run \`fy passkey window <this device>\` at the machine.`;
    case 'cancelled':
      return `The passkey check at ${origin} did not finish. It was dismissed or timed out, or this browser had no passkey for this machine to offer. Try again, or add a passkey from a device that already has access.`;
    case 'unsupported':
      return `This browser cannot use passkeys at ${origin}. Update it, or use a device whose browser supports passkeys.`;
    case 'insecure-origin':
      return `The browser refused a passkey at ${origin}. Passkeys need a secure address (HTTPS or localhost) and work only at the address they were made on, so open the app at that address.`;
  }
}

/**
 * Create a passkey for the daemon. `supported` is whether this browser has `PublicKeyCredential` at
 * all; it is a parameter so the absence is testable without patching a global.
 */
export async function createPasskey(
  port: CredentialsPort,
  options: RegistrationOptionsWire,
  supported: boolean = typeof PublicKeyCredential !== 'undefined',
): Promise<RegistrationWire> {
  if (!supported) throw new PasskeyCeremonyError('unsupported');
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: binary(options.challenge),
    rp: { id: options.rp.id, name: options.rp.name },
    user: { id: binary(options.user.id), name: options.user.name, displayName: options.user.displayName },
    pubKeyCredParams: options.pubKeyCredParams.map(parameter => ({ type: parameter.type, alg: parameter.alg })),
    excludeCredentials: (options.excludeCredentials ?? []).map(descriptor),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
  const credential = await ceremony(() => port.create({ publicKey }));
  const response = credential.response;
  if (!isBuffer(response.clientDataJSON) || !isBuffer(response.attestationObject)) {
    throw new PasskeyCeremonyError('unsupported');
  }
  return {
    credentialId: text(credential.rawId),
    clientDataJSON: text(response.clientDataJSON),
    attestationObject: text(response.attestationObject),
  };
}

/** Prove presence and verification with an existing passkey (the daemon's step-up). */
export async function assertPasskey(
  port: CredentialsPort,
  options: AssertionOptionsWire,
  supported: boolean = typeof PublicKeyCredential !== 'undefined',
): Promise<AssertionWire> {
  // An empty list would let the browser offer ANY passkey for this origin, including one belonging
  // to another machine; the daemon would refuse it, after a prompt that could never have succeeded.
  if (options.allowCredentials.length === 0) throw new PasskeyCeremonyError('no-passkey');
  if (!supported) throw new PasskeyCeremonyError('unsupported');
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: binary(options.challenge),
    rpId: options.rpId,
    allowCredentials: options.allowCredentials.map(descriptor),
    userVerification: 'required',
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
  const credential = await ceremony(() => port.get({ publicKey }));
  const response = credential.response;
  if (!isBuffer(response.clientDataJSON) || !isBuffer(response.authenticatorData) || !isBuffer(response.signature)) {
    throw new PasskeyCeremonyError('unsupported');
  }
  return {
    credentialId: text(credential.rawId),
    clientDataJSON: text(response.clientDataJSON),
    authenticatorData: text(response.authenticatorData),
    signature: text(response.signature),
  };
}

/** The fields of a `PublicKeyCredential` this module reads; checked, never assumed. */
interface CredentialShape {
  readonly rawId: ArrayBuffer;
  readonly response: Record<string, unknown>;
}

async function ceremony(run: () => Promise<Credential | null>): Promise<CredentialShape> {
  let credential: Credential | null;
  try {
    credential = await run();
  } catch (error) {
    throw ceremonyError(error);
  }
  // A null result is the browser declining without an exception, which a person experiences as a dismissal.
  if (credential === null) throw new PasskeyCeremonyError('cancelled');
  const shape = credential as unknown as Partial<CredentialShape>;
  if (!isBuffer(shape.rawId) || typeof shape.response !== 'object' || shape.response === null) {
    throw new PasskeyCeremonyError('unsupported');
  }
  return { rawId: shape.rawId, response: shape.response };
}

function ceremonyError(error: unknown): unknown {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyCeremonyError('cancelled');
  if (name === 'SecurityError') return new PasskeyCeremonyError('insecure-origin');
  if (name === 'NotSupportedError') return new PasskeyCeremonyError('unsupported');
  return error;
}

function descriptor(credential: { type: 'public-key'; id: string }): PublicKeyCredentialDescriptor {
  return { type: credential.type, id: binary(credential.id) };
}

function binary(field: string): ArrayBuffer {
  const bytes = fromBase64Url(field);
  // The daemon wrote these fields; one that does not decode is a version skew, and the value itself
  // (a challenge or an id) is deliberately not repeated in the message.
  if (bytes === null) throw new TypeError('The machine sent passkey options this app cannot read.');
  return bytes.slice().buffer as ArrayBuffer;
}

function isBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function text(buffer: ArrayBuffer): string {
  return toBase64Url(new Uint8Array(buffer));
}
