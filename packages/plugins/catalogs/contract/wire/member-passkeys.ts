/** TODO(Access contract): byte-copied member ceremony wire from protocol/step-up.ts. */
import { z } from 'zod';
import { InstantSchema } from './foreign.ts';
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

export const MAX_PASSKEYS_PER_DEVICE = 8 as const;

export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;

export type PasskeyAlgorithmId = (typeof PASSKEY_ALGORITHMS)[number];

const Base64UrlSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u, 'not unpadded base64url');

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

export const MAX_JOIN_PROOF_PASSKEYS = 64 as const;

const JoinProofOptionsSchema = StepUpOptionsSchema.extend({
  allowCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .min(1)
    .max(MAX_JOIN_PROOF_PASSKEYS),
});

export type JoinProofOptions = z.infer<typeof JoinProofOptionsSchema>;

const DeviceKeyRotationSchema = z.strictObject({
  deviceKey: Base64UrlSchema(64),
  proof: Base64UrlSchema(128),
});

export const StepUpAssertionSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
  rotation: DeviceKeyRotationSchema.optional(),
});
export type StepUpAssertion = z.infer<typeof StepUpAssertionSchema>;

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

export const PasskeyRegistrationSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  attestationObject: Base64UrlSchema(21_846),
  confirmation: StepUpAssertionSchema.optional(),
});

export type PasskeyRegistration = z.infer<typeof PasskeyRegistrationSchema>;

export const PasskeyViewSchema = z.strictObject({
  id: Base64UrlSchema(1_366),
  origin: AppOriginSchema,
  createdAt: InstantSchema,
});

export type PasskeyView = z.infer<typeof PasskeyViewSchema>;
export const UnlockGrantedSchema = z.strictObject({
  unlockedUntil: InstantSchema,
  keyRotated: z.literal(true).optional(),
});

export type UnlockGranted = z.infer<typeof UnlockGrantedSchema>;

export const PasskeyOptionsRequestSchema = z.strictObject({ origin: AppOriginSchema });
