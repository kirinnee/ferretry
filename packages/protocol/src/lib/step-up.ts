import { z } from 'zod';
import { InstantSchema } from './common.ts';

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
export const STEP_UP_TTL_SECONDS = 900 as const;

/** How long a challenge the daemon issued may be answered. It is spent on its first answer either way. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

/**
 * How long after pairing a device with no passkey yet may register its first one without a step-up.
 *
 * The moment the owner is holding the device. After it, a thief holding an unlocked app cannot add an
 * authenticator of their own: a second passkey needs a current step-up, or the machine itself.
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

/** A web origin as the browser reports it: scheme, host and port, nothing after. */
export const AppOriginSchema = z
  .string()
  .max(512)
  .refine(value => {
    try {
      const url = new URL(value);
      return url.origin === value;
    } catch {
      return false;
    }
  }, 'not a web origin');

/** What the browser asks for: options for THIS app origin, which becomes the relying-party id. */
export const PasskeyOptionsRequestSchema = z.strictObject({ origin: AppOriginSchema });
export type PasskeyOptionsRequest = z.infer<typeof PasskeyOptionsRequestSchema>;

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
});
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptionsSchema>;

/** A new credential, as `navigator.credentials.create` produced it. */
export const PasskeyRegistrationSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  attestationObject: Base64UrlSchema(21_846),
});
export type PasskeyRegistration = z.infer<typeof PasskeyRegistrationSchema>;

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
 * A device key replacing the one that opened this session (`docs/design/zero-trust.md` B6): the NEW
 * key's SPKI, and its signature over `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey)`
 * for the transcript of the session carrying it. Bounded here; the daemon checks it is an Ed25519 key.
 */
export const DeviceKeyRotationSchema = z.strictObject({
  deviceKey: Base64UrlSchema(64),
  proof: Base64UrlSchema(128),
});
export type DeviceKeyRotation = z.infer<typeof DeviceKeyRotationSchema>;

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
 * `registration` says why a new passkey may be added (`first-window`, `stepped-up`, `host`) or that it
 * may not (`closed`); `stepUpUntil` is the current step-up's end, when there is one.
 */
export const PasskeysViewSchema = z.strictObject({
  passkeys: z.array(PasskeyViewSchema).max(MAX_PASSKEYS_PER_DEVICE),
  registration: z.enum(['first-window', 'stepped-up', 'host', 'closed']),
  registrationClosesAt: InstantSchema.optional(),
  stepUpUntil: InstantSchema.optional(),
});
export type PasskeysView = z.infer<typeof PasskeysViewSchema>;

/**
 * Why a ceremony was refused, as one closed set a client branches on.
 *
 * Each is a different next step for the person: `registration-closed` means "add it from a device that
 * already has access, or pair again at the machine"; `no-passkey` means this app origin has none;
 * `origin-not-allowed` means this copy of the app is not one the machine serves; `rotation-required` means
 * this device's key is overdue for replacement and the assertion did not carry one; `not-verified` means
 * the passkey answer did not check out (a stale challenge, a different authenticator, a rewound
 * counter) — never which of those, because the detail helps an attacker and nobody else.
 */
export const STEP_UP_REFUSALS = [
  'not-a-device',
  'origin-not-allowed',
  'registration-closed',
  'too-many-passkeys',
  'no-passkey',
  'not-verified',
  'rotation-required',
] as const;
export type StepUpRefusal = (typeof STEP_UP_REFUSALS)[number];

/** The error code a refusal answers with, distinct per reason so a client never parses prose. */
export const stepUpRefusalCode = (refusal: StepUpRefusal): string => `step_up_${refusal.replaceAll('-', '_')}`;

/**
 * The error code a governed route answers with when it needs a step-up this caller does not hold.
 *
 * Spelled the way the grant layer spells every refusal (`grant_` + the refusal), because it IS a grant
 * refusal: the operator allowed the act, and this copy of the app has not proved its owner recently.
 */
export const STEP_UP_REQUIRED_CODE = 'grant_step_up_required' as const;
