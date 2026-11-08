import type { PasskeyAlgorithmId } from '../boundary.ts';

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
  /** Stores a new credential. Refuses — never overwrites — one any device already holds, this one included. */
  add(passkey: StoredPasskey): Promise<void>;
  /**
   * Records a verified assertion's counter as ONE compare-and-set, and says whether it moved: `false`
   * when the stored count is already at or past `signCount` (unless both are zero — an authenticator
   * that keeps no counter) or the passkey is gone. Two copies of the app verifying against the same
   * stored count must not both win, or the later write rewinds it and hides a cloned authenticator.
   */
  updateSignCount(deviceId: string, credentialId: string, signCount: number): Promise<boolean>;
  forgetDevice(deviceId: string): Promise<void>;
}

/** The verifier's verdicts, as this module consumes them. The verifier itself lives in `../passkeys`. */
type PasskeyVerdict<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

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
  /**
   * A KEPT assertion checked again offline (`verifyStoredAssertion`): every check but the counter, against the
   * passkey's own origin. Never for a live ceremony. Absent: no stored proof ever verifies.
   */
  verifyStoredAssertion?(input: {
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signature: Uint8Array;
    readonly expectedChallenge: Uint8Array;
    readonly passkey: {
      readonly algorithm: PasskeyAlgorithmId;
      readonly publicKeySpki: Uint8Array;
      readonly origin: string;
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

/**
 * Where each device's last UNLOCK is kept across a restart (owner: "can you make it such that we don't
 * need to authenticate every time the daemon updates?").
 *
 * A device id and an instant per device — nothing that proves anything, and nothing a copy could replay:
 * the device still has to open a session with its own key, and the unlock still lapses at
 * `unlockValidityHours` from that instant under the settings in force. Writing this file needs this
 * machine's disk, which already holds the admin token.
 */
export interface UnlockLedgerPort {
  read(): Promise<ReadonlyMap<string, number>>;
  write(unlocks: ReadonlyMap<string, number>): Promise<void>;
}
