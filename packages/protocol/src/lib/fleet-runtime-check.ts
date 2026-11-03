/**
 * `POST /v1/fleet/runtimes/:runtimeId/check` — ONE real "reply OK" through a runtime, on its own
 * default model (docs/provider-presets.md § Test, "Check a runtime"): the start probe `fy new` runs
 * before a ferret starts, asked for on purpose. It proves the runtime will start a ferret — its
 * launcher, its login's secrets and cloud credential, the provider's sign-in, region and model access —
 * where a login's free Test proves only that a key is accepted. It spends one real call: a few cents
 * on a pay-per-token login, nothing extra on a subscription. 30 seconds at most.
 *
 * THE SENTENCE IS NEVER THE CLI'S OUTPUT. It is built from the failure `code` and plain facts the
 * daemon already holds — the runtime's name, its provider's label, a region, a profile NAME, a secret
 * NAME, the model id — because what a CLI prints can echo a key or a URL with a password in it.
 *
 * A pass is kept by the same cache `fy new` reads, so the first ferret on the runtime does not probe
 * again; a failure is never kept, so "test again" always asks again.
 */
import { z } from 'zod';
import { NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';

/** The body: nothing. Strict, so a field an older client still sends is refused rather than ignored. */
export const FleetRuntimeCheckRequestSchema = z.strictObject({});
export type FleetRuntimeCheckRequest = z.infer<typeof FleetRuntimeCheckRequestSchema>;

/**
 * Why a check did not pass, as a code a client branches on:
 *
 * - `not_logged_in` — the provider refused the login: not signed in, a key refused, a profile denied.
 * - `out_of_quota` — out of quota or rate-limited.
 * - `model_unavailable` — the provider does not serve the model, or not in that region.
 * - `timed_out` — no answer within 30 seconds.
 * - `not_launchable` — the runtime could not be started at all: no launcher, or a secret its login names is missing.
 * - `no_answer` — it ran, but did not answer OK, for no reason it said.
 */
export const FLEET_RUNTIME_CHECK_CODES = [
  'not_logged_in',
  'out_of_quota',
  'model_unavailable',
  'timed_out',
  'not_launchable',
  'no_answer',
] as const;
export const FleetRuntimeCheckCodeSchema = z.enum(FLEET_RUNTIME_CHECK_CODES);
export type FleetRuntimeCheckCode = z.infer<typeof FleetRuntimeCheckCodeSchema>;

export const FleetRuntimeCheckResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** How long the answer took, in milliseconds (the kept answer's, when a recent pass was reused). */
    ms: NonNegativeIntegerSchema,
    /** "claude-bedrock answered through Amazon Bedrock (us-east-1) in 2.4 s." */
    sentence: NonEmptyStringSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    ms: NonNegativeIntegerSchema,
    code: FleetRuntimeCheckCodeSchema,
    /** "Amazon Bedrock refused the model in us-east-1." Built from `code` and plain facts, never output. */
    sentence: NonEmptyStringSchema,
  }),
]);
export type FleetRuntimeCheckResult = z.infer<typeof FleetRuntimeCheckResultSchema>;

/** Every refusal the check answers with instead of a result. */
export const FLEET_RUNTIME_CHECK_REFUSAL_CODES = ['fleet_runtime_unknown', 'fleet_runtime_disabled'] as const;
export const FleetRuntimeCheckRefusalCodeSchema = z.enum(FLEET_RUNTIME_CHECK_REFUSAL_CODES);
export type FleetRuntimeCheckRefusalCode = z.infer<typeof FleetRuntimeCheckRefusalCodeSchema>;
