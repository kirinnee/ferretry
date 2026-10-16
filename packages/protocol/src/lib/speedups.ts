import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema } from './common.ts';
import { SecretNameSchema } from './secrets.ts';

/**
 * Speed-ups: the optional third-party keys that make a daemon faster or cheaper, and the read that
 * says whether each one is set and when it last worked.
 *
 * THREE PROVIDERS, CLOSED SET. Jev (TypeSafe AI's System One decision model) is the Warden's triage
 * guard; Groq and Cerebras are fast chat models used ONLY to clean up a dictated transcript after the
 * browser has recognised it. Neither receives audio: speech recognition stays in the browser.
 *
 * NO VALUE TRAVELS ON THIS WIRE. A key goes IN through the ordinary secret route (`POST /v1/secrets`)
 * under the name {@link SpeedupStatus.secretName} carries, and the daemon spends it through its one
 * outbound holder. Everything below is a name, a boolean, an instant or a sentence a person reads.
 */

export const SpeedupProviderSchema = z.enum(['jev', 'groq', 'cerebras']);
export type SpeedupProvider = z.infer<typeof SpeedupProviderSchema>;

/**
 * What one Test proved, as a closed vocabulary so a screen can say the right next step:
 * `not_set` means paste a key, `rejected` means the key is wrong, everything else is the provider's
 * side (or the network) and a retry may help. `vault_damaged` is the daemon's own secret store and is
 * never reported as `not_set` — a person told "no key" over a store that is merely unreadable pastes
 * a second one on top.
 */
export const SpeedupTestCodeSchema = z.enum([
  'ok',
  'not_set',
  'rejected',
  'rate_limited',
  'timeout',
  'unreachable',
  'provider_error',
  'malformed',
  'vault_damaged',
]);
export type SpeedupTestCode = z.infer<typeof SpeedupTestCodeSchema>;

export const SpeedupTestResultSchema = z.strictObject({
  provider: SpeedupProviderSchema,
  /** The secret the test spent, by NAME — the audit log joins it into its record. */
  secretName: SecretNameSchema,
  ok: z.boolean(),
  code: SpeedupTestCodeSchema,
  /** One fixed sentence per code. Never a provider body: that could echo anything. */
  message: z.string().min(1).max(400),
  latencyMs: NonNegativeFiniteSchema.optional(),
  at: InstantSchema,
});
export type SpeedupTestResult = z.infer<typeof SpeedupTestResultSchema>;

export const SpeedupStatusSchema = z.strictObject({
  provider: SpeedupProviderSchema,
  label: z.string().min(1),
  /** What it speeds up, in one sentence. */
  purpose: z.string().min(1),
  /** Rough cost, so nobody is surprised by a bill. */
  costNote: z.string().min(1),
  /** What leaves this machine when it is used. */
  privacyNote: z.string().min(1),
  /** Where to get a key. Shown as text AND a link, because a link alone can be blocked. */
  keyUrl: z.url(),
  /** What the Test button does, including whether it spends anything. */
  testNote: z.string().min(1),
  secretName: SecretNameSchema,
  /** Whether the secret store holds a value under {@link secretName}. Never the value. */
  set: z.boolean(),
  /** When that value was last replaced, so a test older than the key reads as stale. */
  secretUpdatedAt: InstantSchema.optional(),
  lastTest: SpeedupTestResultSchema.optional(),
  /** True when the key changed after the last test, so "worked" no longer describes this key. */
  testStale: z.boolean(),
});
export type SpeedupStatus = z.infer<typeof SpeedupStatusSchema>;

export const SpeedupsViewSchema = z.strictObject({
  providers: z.array(SpeedupStatusSchema),
  /**
   * `damaged` when the secret store could not be read. Every `set` is then `false` AND this says why,
   * so a screen shows "cannot tell" rather than inventing "not set" over a vault that is merely unreadable.
   */
  vault: z.enum(['ok', 'damaged']),
});
export type SpeedupsView = z.infer<typeof SpeedupsViewSchema>;

/** The daemon address of the status read. */
export const SPEEDUPS_PATH = '/v1/speedups';
