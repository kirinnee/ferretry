/**
 * The team-recommendation wire shapes.
 *
 * Like the worktree shapes, these belong in `@ferretry/protocol` and should move there when a unit
 * owns that package. They are parsed rather than cast, so a daemon that changes the contract fails
 * here with a stated reason.
 *
 * The fleet CHANGE shapes already made that move and are NOT duplicated here: they are
 * `FleetProposalViewSchema` and friends in `@ferretry/protocol`, because three consumers — the
 * daemon that applies, this CLI that prints, and the browser that proposes — have to agree on them.
 */
import { z } from 'zod';

const NonEmpty = z.string().min(1);

/** One model an account could serve the role with. */
const RoleOptionSchema = z.object({
  agent: NonEmpty,
  accountId: NonEmpty,
  model: NonEmpty,
  tradeoff: z.string(),
  score: z.number(),
  caveat: z.string().optional(),
});
export type RoleOption = z.infer<typeof RoleOptionSchema>;

const RoleRecommendationSchema = z.object({
  role: NonEmpty,
  why: z.string(),
  /** Suggested agent count; fan-out roles only. */
  count: z.number().int().positive().optional(),
  primary: RoleOptionSchema,
  alternatives: z.array(RoleOptionSchema).default([]),
});

/** An account the recommender refused to use, and why — the part a human actually acts on. */
const AccountExclusionSchema = z.object({
  accountId: NonEmpty,
  agent: NonEmpty,
  reason: z.string(),
});

export const TeamRecommendationSchema = z.object({
  task: NonEmpty,
  classification: z.string(),
  reasoning: z.string(),
  roles: z.array(RoleRecommendationSchema),
  exclusions: z.array(AccountExclusionSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type TeamRecommendation = z.infer<typeof TeamRecommendationSchema>;

export const RecommendationRequestSchema = z.strictObject({
  task: NonEmpty,
  /** Probe live quota before deciding; `false` makes the guide report quota inputs as missing. */
  usage: z.boolean(),
});
export type RecommendationRequest = z.infer<typeof RecommendationRequestSchema>;
