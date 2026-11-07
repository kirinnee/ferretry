/**
 * The account-health feed (`GET /v1/usage`, and `/usage` + `/metrics` while the machine serves them publicly):
 * one reading of every login's headroom. COPIED from today's `AccountUsageSchema` (epoch-millisecond reset times) and
 * `UsageFeedViewSchema` field for field; the field names are what scripts and the app already parse.
 */
import { ProviderQuotaBalanceSchema } from '@ferretry/plugin-logins/contract';
import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema } from './common.ts';

export const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
export type AccountAvailability = z.infer<typeof AccountAvailabilitySchema>;

/** `spend_limit` is a pause (a budget): the login is held, not broken. */
export const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);
export type AccountUnavailableReason = z.infer<typeof AccountUnavailableReasonSchema>;

/** One upstream account-health row. */
export const AccountUsageSchema = z.object({
  agent: z.string().min(1),
  provider: z.string().optional(),
  ok: z.boolean().optional(),
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.nullable().optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).nullable().optional(),
  weeklyPercent: z.number().finite().min(0).max(100).nullable().optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.nullable().optional(),
  weeklyResetAt: NonNegativeFiniteSchema.nullable().optional(),
  /** An environment login's prepaid credit, when its provider reports one. */
  balance: ProviderQuotaBalanceSchema.optional(),
  /** Equivalent cost this month from this machine's transcripts, when no provider endpoint answers. */
  spendUsd: NonNegativeFiniteSchema.optional(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/** What an authenticated reader (the app, the CLI, the recommender) is served: an ISO instant and an explicit stale flag. */
export const UsageAccountViewSchema = z.object({
  agent: z.string().min(1),
  usageBased: z.boolean().optional(),
  provider: z.string().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  balance: ProviderQuotaBalanceSchema.optional(),
  spendUsd: NonNegativeFiniteSchema.optional(),
});
export type UsageAccountView = z.infer<typeof UsageAccountViewSchema>;

export const UsageFeedViewSchema = z.object({
  at: InstantSchema.optional(),
  stale: z.boolean(),
  accounts: z.array(UsageAccountViewSchema),
});
export type UsageFeedView = z.infer<typeof UsageFeedViewSchema>;

/**
 * The body `/usage` serves to a caller with no credential: epoch milliseconds of the last completed collection (0 when
 * there has never been one), and `ready`, which tells "the fleet is empty" from "the collector failed" (the source
 * answered the same for both, and its only hard gate chose to fail open on it).
 */
export interface UsageFeedDocument {
  readonly at: number;
  readonly ready: boolean;
  readonly accounts: readonly AccountUsage[];
}
