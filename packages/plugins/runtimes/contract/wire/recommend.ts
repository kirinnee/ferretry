/**
 * `POST /v1/recommend` (today's `POST /v1/recommend`, the route `fy recommend` speaks): which login and model
 * should take one task, and why. The answer is a guide, not an order: every role carries its alternatives, and every
 * login the recommender refused carries the reason. `exclusions` and `warnings` are always present, so a caller can tell
 * "nothing was excluded" from "exclusions were not reported".
 *
 * Copied from the route's own inline schema and projection (`mounts/recommend.ts`). The key `agent`/`accountId` words of
 * today's wire are kept (parity); the port may rename them with the app.
 */
import { z } from 'zod';
import { HarnessKeySchema, NonEmptyStringSchema } from './shared.ts';

/** What the client asks. Strict: an unknown field is a caller who thinks this route does more. */
export const RecommendationRequestSchema = z.strictObject({
  task: z.string().min(1),
  /** `false` means the quota inputs are UNREAD (every login ranks as average), not "ignore the answer". */
  usage: z.boolean(),
});
export type RecommendationRequest = z.infer<typeof RecommendationRequestSchema>;

/** One option: the login, the model, the trade-off and the caveat (a fixed slug such as `below-doctrine-floor`). */
export const RoleOptionSchema = z.strictObject({
  agent: HarnessKeySchema,
  accountId: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  tradeoff: z.string(),
  score: z.number(),
  caveat: z.string().optional(),
});
export type RoleOption = z.infer<typeof RoleOptionSchema>;

export const RecommendationSchema = z.strictObject({
  task: z.string(),
  /** PLACEHOLDER: today's `describeClassification` output (the recommender's own taxonomy), carried as the daemon makes it. */
  classification: z.unknown(),
  reasoning: z.string(),
  roles: z.array(
    z.strictObject({
      role: z.string(),
      why: z.string(),
      count: z.number().int().optional(),
      primary: RoleOptionSchema,
      alternatives: z.array(RoleOptionSchema),
    }),
  ),
  exclusions: z.array(z.strictObject({ accountId: NonEmptyStringSchema, agent: HarnessKeySchema, reason: z.string() })),
  warnings: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** `503` when the operator has written no routing catalog. */
export const RECOMMENDER_UNCONFIGURED = 'recommender_unconfigured' as const;
