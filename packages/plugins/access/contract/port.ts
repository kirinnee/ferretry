/**
 * Access's port (§2.3): what other subsystems may read or ask of it. Catalogs `needs` it (member passkeys share
 * Access's WebAuthn verifier); Agenda `uses` it to buzz a phone. Never a device key, a token or a digest.
 */
import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type Buzz, type PairedDevice, PairedDeviceIdSchema } from './wire.ts';

/** The WebAuthn algorithms a passkey may use (COSE ids): ES256 and RS256, as today. */
export type PasskeyAlgorithmId = -7 | -257;

/** A verifier's answer: the facts it proved, or why it refused. Never throws for a bad ceremony. */
export type PasskeyVerdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Today's `PasskeyVerifierPort` (`step-up/types.ts`), field for field: pure WebAuthn checks, no store. */
export interface PasskeyVerifier {
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

export interface AccessApi {
  /** Who may reach this daemon, as anybody but the daemon may see it (no key material). */
  devices(): Promise<readonly PairedDevice[]>;
  /** The WebAuthn checks Access's own passkeys use; Catalogs' member passkeys use the same. */
  readonly passkeys: PasskeyVerifier;
  /** Sends one push to every live enrolment; resolves how many devices it reached (Agenda's buzz). */
  buzz(message: Buzz): Promise<number>;
}

export const AccessPort = definePort<AccessApi>('access');

/** A device was paired, revoked, expired or had its grants changed. A wake-up: read the truth through the port. */
export const DevicesChanged = defineEvent(
  'access.devices-changed',
  z.strictObject({
    device: PairedDeviceIdSchema,
    change: z.enum(['paired', 'revoked', 'expired', 'grants']),
  }),
);
