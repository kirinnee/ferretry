import { defineHook, type FerretId, type HolderId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { z } from 'zod';
import type { CapabilityGrants, StepUpAct, StepUpRefusal } from './policy.ts';
import type { MemberHolderStanding } from './standing.ts';

/**
 * The two security-path provide hooks Gate offers (§4.13, §7.1), taken only by Access (`device`) and Catalogs
 * (`member`). Plugins answer only for the holders they enrolled, by holder id from the kernel's principal, never by a
 * token. The policy itself (daemon-wide grants, unlock and step-up settings) is Gate's (`gate.yaml`).
 *
 * Fail closed: when the taking plugin is off, failed, throwing or damaged, its kind is unknown — every new call of
 * that kind gets R605's identical refusal and every open session or stream of that kind closes (`4401`).
 */

export const HolderKindSchema = z.enum(['device', 'member']);
export type HolderKind = z.infer<typeof HolderKindSchema>;

/** A device as its provider answers for it right now. */
export interface DeviceHolderStanding {
  readonly kind: 'device';
  readonly holder: HolderId;
  /** The device half of the grants; the effective grant is daemon-wide ∧ this (G139). */
  readonly grants: CapabilityGrants;
  /** Absent = locked. */
  readonly unlockedUntil?: Instant;
}

export type HolderStanding = DeviceHolderStanding | MemberHolderStanding;

/**
 * The value of `credentials:<kind>`. Synchronous, memory-only, no secret: the provider's projection, refreshed on its
 * own writes. `unknown` is `undetermined` and refused (G140); `revoked` is refused.
 */
export interface CredentialProvider<S extends HolderStanding = HolderStanding> {
  standing(holder: HolderId, now: Instant): S | 'unknown' | 'revoked';
  /** Bumps on any revoke, narrowing, unlock, lock or grant change; Gate re-admits every open stream of the kind. */
  generation(): number;
}

export const Credentials = defineHook('credentials', {
  mode: 'provide',
  key: HolderKindSchema,
  value: z.custom<CredentialProvider>(),
  takers: ['access', 'catalogs'],
});

// ─── step-up witness ──────────────────────────────────────────────────────────────────────────────────────────────

const Base64UrlSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u, 'not unpadded base64url');

/** A web origin as the browser reports it (today's `AppOriginSchema`). */
export const AppOriginSchema = z
  .string()
  .max(512)
  .refine(value => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, 'not a web origin');

/** A device key replacing the one that opened this session (today's `DeviceKeyRotationSchema`). */
export const DeviceKeyRotationSchema = z.strictObject({
  deviceKey: Base64UrlSchema(64),
  proof: Base64UrlSchema(128),
});

/** An assertion as `navigator.credentials.get` produced it (today's `StepUpAssertionSchema`). */
export const PasskeyAssertionSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
  rotation: DeviceKeyRotationSchema.optional(),
});
export type PasskeyAssertion = z.infer<typeof PasskeyAssertionSchema>;

/** One registered passkey the browser may pick, as the challenge offers it. Never a key. */
export interface PasskeyDescriptor {
  readonly type: 'public-key';
  readonly id: string;
}

/** What Gate hands the witness for one ceremony: the challenge it issued (and spends), bound to one act. */
export interface StepUpCeremony {
  readonly holder: HolderId;
  readonly origin: string;
  readonly challenge: Uint8Array;
  readonly assertion: PasskeyAssertion;
  readonly act?: StepUpAct;
  /** The staged subject an every-caller act is bound to. */
  readonly subject?: string;
  readonly now: Instant;
}

/** A verified ceremony. Gate stamps the window and spends it; the witness never decides whether one was needed. */
export interface StepUpVerified {
  readonly holder: HolderId;
  readonly act?: StepUpAct;
  readonly subject?: string;
  readonly provedAt: Instant;
  /** The assertion carried a rotation and the provider now holds the new key. */
  readonly keyRotated?: true;
}

/**
 * The value of `step-up:<kind>`: verifies a passkey assertion against the holder's registered passkeys (§7.1).
 * Gate decides WHETHER an act needs one (its settings and closed lists), issues and spends challenges and proofs.
 */
export interface StepUpWitness {
  /** The passkeys this holder may answer with for this origin; `unknown` when the holder is not this provider's. */
  passkeys(holder: HolderId, origin: string): readonly PasskeyDescriptor[] | 'unknown';
  verify(ceremony: StepUpCeremony): Promise<StepUpVerified | { readonly refused: StepUpRefusal }>;
}

export const StepUp = defineHook('step-up', {
  mode: 'provide',
  key: HolderKindSchema,
  value: z.custom<StepUpWitness>(),
  takers: ['access', 'catalogs'],
});

// ─── ferret bearers ───────────────────────────────────────────────────────────────────────────────────────────────

/** SHA-256 of a presented bearer, hex. Gate computes it; the directory compares it in constant time. */
export type BearerDigest = string & { readonly __bearerDigest: true };

/**
 * The value of `bearers:ferret`, taken only by Ferrets (spine decision, see docs/rebuild/spine.md §11): Ferrets owns
 * the ferret token hashes (`state/ferrets/tokens.json`) and Gate checks the bearer, but Gate needs only the kernel, so
 * Ferrets answers through this hook instead of Gate reading Ferrets' folder. Synchronous, memory-only; it never
 * returns a digest or a token.
 */
export interface FerretBearerDirectory {
  ferretFor(digest: BearerDigest): FerretId | undefined;
  /** Bumps on every issue, rotation and revoke; Gate re-admits open ferret streams. */
  generation(): number;
}

export const Bearers = defineHook('bearers', {
  mode: 'provide',
  key: z.enum(['ferret']),
  value: z.custom<FerretBearerDirectory>(),
  takers: ['ferrets'],
});
