import type { PasskeyAlgorithmId } from '@ferretry/protocol';

/**
 * One passkey a paired device registered, as this daemon keeps it.
 *
 * A PUBLIC key and a counter — nothing a copy of the file could use. The private half lives in the
 * person's authenticator and never reaches the browser, let alone the daemon.
 */
export interface StoredPasskey {
  /** The credential id the authenticator chose, unpadded base64url. */
  readonly credentialId: string;
  readonly deviceId: string;
  readonly algorithm: PasskeyAlgorithmId;
  /** The credential's public key as SPKI DER, unpadded base64url. */
  readonly publicKeySpki: string;
  readonly signCount: number;
  /** The app origin it was made at, which fixes the relying-party id it answers for. */
  readonly origin: string;
  readonly createdAt: string;
}

/** Where passkeys are kept. Revoking a device forgets its passkeys through `forgetDevice`. */
export interface PasskeyStore {
  list(deviceId: string): Promise<readonly StoredPasskey[]>;
  /**
   * Which device holds this credential, on ANY device, or nothing. A credential belongs to exactly one
   * device: a synced passkey (iCloud Keychain, Google Password Manager) puts the same credential on
   * other phones, and none of them may use it as their own.
   */
  holder(credentialId: string): Promise<string | undefined>;
  /** Stores a new credential. Refuses — never overwrites — one another device already holds. */
  add(passkey: StoredPasskey): Promise<void>;
  /** Records a verified assertion's counter. A passkey that is gone meanwhile is not an error. */
  updateSignCount(deviceId: string, credentialId: string, signCount: number): Promise<void>;
  forgetDevice(deviceId: string): Promise<void>;
}

/** The verifier's verdicts, as this module consumes them. The verifier itself lives in `../passkeys`. */
export type PasskeyVerdict<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/**
 * The WebAuthn verifier, as the step-up service needs it: every byte it checks, already decoded.
 *
 * A port so the service is testable without hand-building authenticator output for every case, and so
 * the verifier — the part where a mistake is an authentication bypass — has exactly one owner.
 */
export interface PasskeyVerifierPort {
  verifyRegistration(input: {
    readonly clientDataJSON: Uint8Array;
    readonly attestationObject: Uint8Array;
    readonly expectedChallenge: Uint8Array;
    readonly allowedOrigins: readonly string[];
  }): Promise<
    PasskeyVerdict<{
      readonly credentialId: Uint8Array;
      readonly algorithm: PasskeyAlgorithmId;
      readonly publicKeySpki: Uint8Array;
      readonly signCount: number;
      readonly origin: string;
    }>
  >;
  verifyAssertion(input: {
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signature: Uint8Array;
    readonly expectedChallenge: Uint8Array;
    readonly allowedOrigins: readonly string[];
    readonly credential: {
      readonly algorithm: PasskeyAlgorithmId;
      readonly publicKeySpki: Uint8Array;
      readonly signCount: number;
    };
  }): Promise<PasskeyVerdict<{ readonly signCount: number; readonly origin: string }>>;
}

/** Fresh randomness for challenges, from an adapter. */
export interface StepUpRandom {
  bytes(length: number): Uint8Array;
}

export interface StepUpClock {
  nowMs(): number;
}

/** What the service needs to know about a device: its name, and when it was paired. */
export interface StepUpDeviceDirectory {
  device(deviceId: string): Promise<{ readonly name: string; readonly createdAt: string } | undefined>;
}

/**
 * Who is asking. `device` is the session's proven device; `hostLocal` is the boundary's own proof that
 * this is the OWNER at the machine (`arrivedOnHost`); `actor` names them in the audit. None comes
 * from a body.
 */
export interface StepUpCaller {
  readonly device?: { readonly deviceId: string; readonly appSession: string };
  readonly hostLocal: boolean;
  /**
   * The transcript hash of the session carrying this request — what a key rotation's proof is signed
   * over. Present only for a request a session carried; a rotation without one is refused.
   */
  readonly transcriptHash?: Uint8Array;
  readonly actor?: string;
}

/**
 * Replacing a device's key inside a step-up (`docs/design/zero-trust.md` B6), as the step-up service
 * needs it. The verifier of the new key's proof, the swap, and the one fact that decides whether a
 * rotation is due: when the device's current key was put in place.
 */
export interface DeviceKeyRotationPort {
  /** When the device's current key was put in place, or nothing for a device that is gone. */
  keyIssuedAt(deviceId: string): number | undefined;
  /** Whether `proof` is `deviceKey`'s signature over this session's rotation message. Total. */
  verify(input: {
    readonly transcriptHash: Uint8Array;
    readonly deviceId: string;
    readonly deviceKey: string;
    readonly proof: string;
  }): Promise<boolean>;
  /**
   * Adopts the new key, closes every OTHER session the device holds so each reopens with it, and
   * audits `device.key-rotated`. `false` when the device was gone by the time it was written.
   */
  rotate(input: {
    readonly deviceId: string;
    readonly deviceKey: string;
    /** The carrying session's transcript hash, so that session is the one NOT closed. */
    readonly transcriptHash: Uint8Array;
  }): Promise<boolean>;
}
