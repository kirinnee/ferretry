/**
 * Access's port (§2.3): what other subsystems may read or ask of it. Catalogs `needs` it (member passkeys share
 * Access's WebAuthn verifier); Agenda `uses` it to buzz a phone. Never a device key, a token or a digest.
 */
import { defineEvent, defineHook, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type PairedDevice, PairedDeviceIdSchema } from './pairing.ts';
import type { PasskeyAlgorithmId, StoredStepUpProofSchema } from './step-up.ts';
import type { Buzz } from './wire.ts';

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
  /**
   * Takes buzzes down on every enrolled device but `except`'s (a paired device's id): the lines named by `tags`
   * (`pa-<id>`, `attention-<ferret>:<ask>`), each bounded by the push clear's own cap. A clear carries NO content, only
   * tags. `ferret` names the ferret the clear is about (absent: the machine). Resolves how many devices were told.
   * Additive: a caller that finds it absent cannot take a line down, and says nothing it did not do.
   */
  clear?(tags: readonly string[], except?: string, ferret?: string): Promise<number>;
  /**
   * Whether this paired device holds at least one passkey (S92: a 2FA seed save answers `409 passkey_required` for a
   * device that holds none). Unknown or revoked devices hold none. Never a credential id or key.
   */
  holdsPasskey(deviceId: string): Promise<boolean>;
  /** Whether a still-paired device holds this registered credential. No key or credential list is returned. */
  holds(deviceId: string, credentialId: string): Promise<boolean>;
  /** Rechecks a kept assertion against its derived challenge and its credential's own origin, without a counter. */
  verifyStoredProof(proof: z.infer<typeof StoredStepUpProofSchema>, expectedChallenge: Uint8Array): Promise<boolean>;
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

/** The staged acts whose passkey challenge is stamped with a subject the staging plugin owns (G83). */
export const STAGED_STEP_UP_ACTS = [
  'add-2fa-key',
  'approve-task-plan',
  'approve-sign-in-rule',
  'approve-paste-rule',
] as const;
export const StagedStepUpActSchema = z.enum(STAGED_STEP_UP_ACTS);
export type StagedStepUpAct = z.infer<typeof StagedStepUpActSchema>;

/**
 * What Access asks the plugin that staged a step-up subject, when a device asks for its challenge. Both answers are
 * `undefined` when the stage is not waiting (for THIS device, where the act is per-device): Access then answers
 * `stage_not_found` and issues no challenge.
 *
 * - `add-2fa-key` (Accounts, S90): `subjectOf(stage)` is `sha256("ferretry.add-2fa-key.v1\\0" + accountKey + "\\0" + stage)`,
 *   never the stage id; Access stamps the challenge with exactly that digest and the save takes only a proof stamped
 *   with its own account and stage.
 * - `approve-task-plan` (Accounts, `bindings.plans`): `subjectOf(stage)`.
 * - `approve-paste-rule` (Accounts): `subjectOf(stage, deviceId, kind)`.
 * - `approve-sign-in-rule` (Accounts): `challengeOf(stage, deviceId)`, the challenge derived from the rule's body.
 */
export interface StagedStepUp {
  subjectOf?(stage: string, deviceId: string, kind?: 'rule' | 'profile-targets'): string | undefined;
  challengeOf?(stage: string, deviceId: string): Uint8Array | undefined;
}

/** `step-up.stages:<act>`: offered by Access, provided by the plugin that stages that act's subject. */
export const StepUpStages = defineHook('step-up.stages', {
  mode: 'provide',
  key: StagedStepUpActSchema,
  value: z.custom<StagedStepUp>(),
  takers: ['accounts', 'board'],
});
