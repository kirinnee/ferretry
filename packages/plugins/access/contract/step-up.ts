import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  type EveryCallerStepUpAct,
  PasteRuleStageIdSchema,
  SignInRuleStageIdSchema,
  STEP_UP_DEFAULT_WINDOW_MINUTES,
  STEP_UP_SUBJECTS,
  StepUpActSchema,
  stepUpSkippableAtMachine,
  TaskPlanStageIdSchema,
  TwoFactorStageIdSchema,
} from '@ferretry/core-gate/contract';
import { PairedDeviceIdSchema } from './pairing.ts';

/**
 * THE PASSKEY STEP-UP, ON THE WIRE (`docs/design/zero-trust.md` B1–B2).
 *
 * The browser performs the WebAuthn ceremony and the DAEMON verifies it. Everything here travels inside
 * a session the device key opened, so the relay sees none of it; what this module fixes is the shape
 * both ends agree on — the options the daemon issues, what the browser sends back, and what a person
 * is told when it does not work.
 *
 * Binary values are unpadded base64url, the encoding every other record in this protocol uses.
 */

/**
 * How long one verified step-up covers the acts that ask for one, for one running copy of the app, on a
 * machine whose owner never changed it: the default of the `stepUpWindowMinutes` setting (`./security.ts`).
 */
export const STEP_UP_TTL_SECONDS = STEP_UP_DEFAULT_WINDOW_MINUTES * 60;

/** How long a challenge the daemon issued may be answered. It is spent on its first answer either way. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

/**
 * How long after pairing a device with no passkey yet may register its first one without a step-up.
 *
 * The moment the owner is holding the device. After it, a thief holding an unlocked app cannot add an
 * authenticator of their own: a second passkey needs a fresh assertion by one this device already holds
 * ({@link PasskeyRegistrationOptionsSchema}'s `confirm`), or the owner at the machine.
 */
export const PASSKEY_REGISTRATION_WINDOW_SECONDS = 600 as const;

/** How many passkeys one device may hold. Enough for a phone's platform key and a hardware key or two. */
export const MAX_PASSKEYS_PER_DEVICE = 8 as const;

/** COSE algorithm identifiers this daemon verifies: ES256, EdDSA (Ed25519) and RS256. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
export type PasskeyAlgorithmId = (typeof PASSKEY_ALGORITHMS)[number];

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

/** What the browser asks for: options for THIS app origin, which becomes the relying-party id. */
export const PasskeyOptionsRequestSchema = z.strictObject({ origin: AppOriginSchema });
export type PasskeyOptionsRequest = z.infer<typeof PasskeyOptionsRequestSchema>;

/**
 * Options for a step-up. `act` is the one act the person is about to confirm: the daemon stamps the
 * proof with it, and an act that asks for its own proof (a catalog install) takes only a proof stamped
 * for it. Absent, the proof is unstamped and no such act takes it.
 *
 * `subject` is the one thing a {@link STEP_UP_ACTS_EVERY_CALLER} act is for (the staged seed, `st_…`; the staged task-plan
 * selection, `tps_…`; the staged standing rule, `srs_…`; the staged paste rule, `prs_…`): the daemon binds the
 * challenge, and so the proof, to it, and the commit takes only a proof for that act AND that subject. Sent exactly with
 * such an act, of that act's own kind ({@link STEP_UP_SUBJECTS}), and never with another.
 */
export const StepUpOptionsRequestSchema = PasskeyOptionsRequestSchema.extend({
  act: StepUpActSchema.optional(),
  subject: z
    .union([TwoFactorStageIdSchema, TaskPlanStageIdSchema, SignInRuleStageIdSchema, PasteRuleStageIdSchema])
    .optional(),
}).refine(
  request =>
    request.act === undefined || stepUpSkippableAtMachine(request.act)
      ? request.subject === undefined
      : STEP_UP_SUBJECTS[request.act as EveryCallerStepUpAct as keyof typeof STEP_UP_SUBJECTS].safeParse(
          request.subject,
        ).success,
  { path: ['subject'], message: "name the act's own staged subject exactly when the act is bound to one" },
);
export type StepUpOptionsRequest = z.infer<typeof StepUpOptionsRequestSchema>;

export const StepUpOptionsSchema = z.strictObject({
  challenge: Base64UrlSchema(128),
  rpId: z.string().min(1).max(253),
  allowCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .min(1)
    .max(MAX_PASSKEYS_PER_DEVICE),
  timeout: z.number().int().positive(),
});
export type StepUpOptions = z.infer<typeof StepUpOptionsSchema>;

/**
 * How many passkeys a join challenge may offer. A person has up to 200 browsers with up to
 * {@link MAX_PASSKEYS_PER_DEVICE} passkeys each, and the browser can only pick from this list, so a device's own cap
 * is far too small here.
 */
export const MAX_JOIN_PROOF_PASSKEYS = 64 as const;

/** The options a later join is challenged with: an unlock's, with room for every browser of the person. */
export const JoinProofOptionsSchema = StepUpOptionsSchema.extend({
  allowCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .min(1)
    .max(MAX_JOIN_PROOF_PASSKEYS),
});
export type JoinProofOptions = z.infer<typeof JoinProofOptionsSchema>;
/**
 * An assertion, as `navigator.credentials.get` produced it — and, once the device's key is due for
 * replacement, the replacement, so one ceremony both confirms the person and rotates the key.
 */
export const StepUpAssertionSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
  rotation: DeviceKeyRotationSchema.optional(),
});
export type StepUpAssertion = z.infer<typeof StepUpAssertionSchema>;

/**
 * A STORED PROOF: what the daemon keeps of a verified ceremony for a {@link STEP_UP_ACTS_STORED_PROOF} act, so the
 * assertion can be checked again offline — the device that proved it and the assertion's bytes exactly as the
 * authenticator signed them. Never a rotation (that is spent by the live ceremony) and never anything the browser
 * could present again as a step-up: the challenge inside `clientDataJSON` is derived from what was approved, and a
 * fresh claim never takes it.
 */
export const StoredStepUpProofSchema = z.strictObject({
  deviceId: PairedDeviceIdSchema,
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
});

/**
 * Options for a new passkey, and — when this device already holds one — the assertion that must come
 * first (`confirm`).
 *
 * ADDING A PASSKEY IS ITS OWN CEREMONY, never a step-up and never authorized by one (zero-trust.md B2).
 * Code in the page can build an attestation with WebCrypto, so nothing in a registration proves an
 * authenticator exists; what it cannot build is a signature by a passkey the daemon already trusts. So
 * a device that holds one must prove it again, against `confirm.challenge`: issued with THIS
 * registration's challenge, bound to it, and spent with it. The first passkey (the window after
 * pairing) and the owner's re-opened window carry no `confirm` — there is nothing yet to bind to.
 */
export const PasskeyRegistrationOptionsSchema = z.strictObject({
  challenge: Base64UrlSchema(128),
  rp: z.strictObject({ id: z.string().min(1).max(253), name: z.string().min(1).max(64) }),
  user: z.strictObject({
    id: Base64UrlSchema(128),
    name: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
  }),
  pubKeyCredParams: z
    .array(z.strictObject({ type: z.literal('public-key'), alg: z.number().int() }))
    .min(1)
    .max(8),
  timeout: z.number().int().positive(),
  excludeCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .max(MAX_PASSKEYS_PER_DEVICE),
  confirm: StepUpOptionsSchema.optional(),
});
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptionsSchema>;

/**
 * A new credential, as `navigator.credentials.create` produced it, with the existing passkey's answer to
 * the options' `confirm` when they carried one.
 */
export const PasskeyRegistrationSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  attestationObject: Base64UrlSchema(21_846),
  confirmation: StepUpAssertionSchema.optional(),
});
export type PasskeyRegistration = z.infer<typeof PasskeyRegistrationSchema>;

/**
 * A verified step-up: when it lapses. Never a value the browser could present — the daemon holds it.
 *
 * `keyRotated` is present exactly when the assertion carried a rotation and the daemon now holds the
 * new key: the browser promotes its pending key on it, and the old one opens nothing from then on.
 */
export const StepUpGrantedSchema = z.strictObject({ expiresAt: InstantSchema, keyRotated: z.literal(true).optional() });
export type StepUpGranted = z.infer<typeof StepUpGrantedSchema>;

/** One passkey this device holds, as the device list and the Security panel show it. Never a key. */
export const PasskeyViewSchema = z.strictObject({
  id: Base64UrlSchema(1_366),
  origin: AppOriginSchema,
  createdAt: InstantSchema,
});
export type PasskeyView = z.infer<typeof PasskeyViewSchema>;

/**
 * What this device may do about passkeys right now, so a surface offers only what will work.
 *
 * `registration` says how a new passkey may be added — `first-window` (just paired), `confirm-existing`
 * (by confirming with a passkey this device already holds), `reopened` (the owner re-opened a window for
 * this device at the machine) — or that it may not (`closed`); `stepUpUntil` is the current step-up's
 * end, when there is one. A step-up is never one of the ways: holding one adds nothing.
 */
export const PasskeysViewSchema = z.strictObject({
  passkeys: z.array(PasskeyViewSchema).max(MAX_PASSKEYS_PER_DEVICE),
  registration: z.enum(['first-window', 'confirm-existing', 'reopened', 'closed']),
  registrationClosesAt: InstantSchema.optional(),
  stepUpUntil: InstantSchema.optional(),
});
export type PasskeysView = z.infer<typeof PasskeysViewSchema>;

/**
 * The OWNER, at the machine, re-opens the passkey registration window for one paired device.
 *
 * The recovery path, and the only one: a browser is never "at the machine" (B4), so a device that missed
 * its first window and holds no passkey — or lost the authenticator that held it — could otherwise never
 * step up again. The window is {@link PASSKEY_REGISTRATION_WINDOW_SECONDS} long, opens for exactly one
 * device, and is spent by the first passkey registered in it.
 */
export const PASSKEY_WINDOW_PATH = '/v1/passkeys/registration-window' as const;

export const PasskeyWindowRequestSchema = z.strictObject({ deviceId: PairedDeviceIdSchema });
export type PasskeyWindowRequest = z.infer<typeof PasskeyWindowRequestSchema>;

export const PasskeyWindowOpenedSchema = z.strictObject({
  deviceId: PairedDeviceIdSchema,
  deviceName: z.string().min(1).max(200),
  closesAt: InstantSchema,
});
export type PasskeyWindowOpened = z.infer<typeof PasskeyWindowOpenedSchema>;
