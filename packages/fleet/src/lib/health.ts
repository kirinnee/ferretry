/**
 * Credential health — "is this login signed in", answered without spending a cent.
 *
 * `healthy` means the CURRENT credential was recently accepted by its provider, NOT "this account has
 * quota", "every model is entitled" or "the provider is up". The verdict is decided from a usage read
 * somebody already made plus a LOCAL credential classification (`./account/credential-status.ts`), so
 * nothing here launches a process, opens a socket or sends a request, and there is no seam to hang a
 * spend on.
 *
 * Nothing here reads, writes, hashes or names credential material. Classification takes a state a
 * caller already derived; the material itself stays behind an adapter, exactly as `./identity.ts`
 * requires.
 */
import type { CredentialState } from './identity.ts';
import type { FleetManifestAccount } from './manifest.ts';

/**
 * How long a conclusive verdict stays trustworthy.
 *
 * A constant rather than configuration, because there is no cost to trade off any more: the evidence
 * arrives with a read the daemon already makes on its own cadence, so an operator tuning this would
 * only be choosing how long to keep believing a number nobody is paying for. Fifteen minutes against
 * the usage pass's one-minute default means a conclusion is normally re-proved fourteen times before
 * it could ever expire, and a fleet whose provider is unreachable degrades to `unknown` rather than
 * quietly showing a verdict from an hour ago.
 *
 * IT EXPIRES NEGATIVE VERDICTS TOO. Somebody who signs in again outside Ferretry — in a terminal, in
 * another tool — must not stay condemned by a `401` this daemon happened to observe first.
 */
export const FLEET_HEALTH_FRESH_MS = 15 * 60 * 1_000;

/**
 * What a LOCAL credential read found. Produced by an adapter; no material reaches this module.
 *
 * `fingerprint` is an opaque, non-reversible digest of the material, and it exists for exactly one
 * job: proving whether the credential CHANGED between two observations. It is never a token, never
 * derived in a way that can be reversed, and absent whenever there was no material to digest.
 */
export interface LocalCredentialReading {
  readonly state: CredentialState;
  readonly fingerprint?: string;
  /** Epoch milliseconds the access token expires, when the credential said so. */
  readonly expiresAt?: number;
}

/** Reading and classifying one account home's credential. The sole impure boundary. */
export interface FleetCredentialClassifier {
  classify(account: FleetManifestAccount): Promise<LocalCredentialReading>;
}
