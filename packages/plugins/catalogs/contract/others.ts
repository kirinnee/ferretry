/**
 * Access's port, as Catalogs uses it: a STAND-IN by token name (the generator matches ports by name), because a
 * plugin imports another plugin's contract only on the two allowed edges (Usage→Logins, Packs→Runtimes). Catalogs'
 * member passkeys use Access's WebAuthn verifier; this is today's `PasskeyVerifierPort` (`step-up/types.ts`).
 */
import { definePort } from '@ferretry/kernel/contract';

export type PasskeyAlgorithmId = -7 | -257;
export type PasskeyVerdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface AccessPasskeysApi {
  readonly passkeys: {
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
  };
}

export const AccessPort = definePort<AccessPasskeysApi>('access');
