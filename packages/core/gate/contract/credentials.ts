import { type Cancel, defineHook, type FerretId, type HolderId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { z } from 'zod';
import type {
  CapabilityGrants,
  EveryCallerStepUpAct,
  MachineSkippableStepUpAct,
  StepUpSubjectOf,
  StoredProofStepUpAct,
} from './policy.ts';
import type { MemberHolderStanding, StoredStepUpProof } from './standing.ts';

/**
 * The security-path provide hooks Gate offers (§4.13, §7.1): `credentials`, taken only by Access (`device`) and
 * Catalogs (`member`), and `step-up`, taken only by Access (`device`). Plugins answer only for the holders they
 * enrolled, by holder id from the kernel's principal, never by a token. The policy itself (daemon-wide grants, unlock
 * and step-up settings) is Gate's (`gate.yaml`).
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
  /**
   * Tells `listener` each time `generation()` moves (a revoke, narrowing, unlock, lock or grant change), after the
   * new standing can be read, and returns the cancel. Gate subscribes to every provider it is bound to and re-asks
   * every open stream on each notice (G149), so a device narrowed by Access loses its stream at once instead of at its
   * next frame. Optional: a provider that does not push is still re-asked on every call and frame. A throwing listener
   * is the provider's to isolate.
   */
  watch?(listener: () => void): Cancel;
}

export const Credentials = defineHook('credentials', {
  mode: 'provide',
  key: HolderKindSchema,
  value: z.custom<CredentialProvider>(),
  takers: ['access', 'catalogs'],
});

// ─── step-up wire shapes (Access and Accounts read these) ─────────────────────────────────────────────────────────

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

// ─── step-up witness ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One copy of the app on one paired device (today's `SessionDevice`): the step-up is a fact about THIS device and
 * THIS app session, never about a device as a whole (G100). Gate builds it from the kernel's principal only.
 */
export interface StepUpSubject {
  readonly deviceId: string;
  readonly appSession: string;
}

/** {@link StepUpWitness.claimFresh}, overloaded so an act every caller must prove cannot be asked the short way. */
export interface ClaimFreshWitness {
  (subject: StepUpSubject, act?: MachineSkippableStepUpAct): boolean;
  (subject: StepUpSubject, act: Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>, bound: string): boolean;
}

/**
 * The value of `step-up:device` (today's boundary `StepUpWitness`, which today's `StepUpService` satisfies): Access
 * owns the passkeys, the ceremonies, the unlock and the proofs, and answers these questions; Gate asks them at
 * admission and decides WHETHER an act needs a step-up (its settings and closed lists). Synchronous where admission
 * is synchronous, memory-only, no secret.
 *
 * FAIL CLOSED: with no provider (Access off, failed, throwing or damaged) nobody holds a step-up or a fresh proof,
 * every claim is answered `false` or nothing, nothing is spent, and every device must unlock before it is served.
 */
export interface StepUpWitness {
  /** Whether this copy of the app holds a step-up right now (the unlock standing in for it, or a window). */
  held(subject: StepUpSubject): boolean;
  /** Whether it proved a passkey for the act at hand and has not spent it. */
  freshlyHeld(subject: StepUpSubject): boolean;
  /** Whether this device must confirm a person is present before it is served at all (`unlockOnOpen`, G74). */
  unlockRequired(subject: StepUpSubject): boolean;
  /**
   * Takes that proof atomically: of concurrent acts on one proof, exactly one is answered `true`. An act every caller
   * must prove names what its proof is bound to, and takes no other proof; no other claim takes one of its proofs.
   */
  claimFresh: ClaimFreshWitness;
  /**
   * Takes the KEPT assertion of a passkey proved for a stored-proof act on exactly `stage`, once, while it is fresh,
   * and only when `expectedChallenge` is the challenge it was verified against — or nothing (G85).
   */
  claimStoredProof<Act extends StoredProofStepUpAct>(
    subject: StepUpSubject,
    act: Act,
    stage: StepUpSubjectOf<Act>,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined;
  /** Verifies a kept proof again, against a holder that is still paired; `false` for anything else. */
  verifyStoredProof(proof: StoredStepUpProof, expectedChallenge: Uint8Array): Promise<boolean>;
  /** Spends the fresh proof. */
  spendFresh(subject: StepUpSubject): void;
  /** One act that needed the step-up was just admitted: spends it when the machine asks every time (G97). */
  spend(subject: StepUpSubject): void;
  /** When this device's key is due for replacement (epoch ms), or `undefined` when it is not known. */
  rotateBy(deviceId: string): number | undefined;
}

/** Access alone answers for the step-up: Catalogs' members unlock with their own passkeys and never step up. */
export const StepUp = defineHook('step-up', {
  mode: 'provide',
  key: z.enum(['device']),
  value: z.custom<StepUpWitness>(),
  takers: ['access'],
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
