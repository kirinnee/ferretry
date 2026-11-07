/**
 * Accounts' ids (today's `protocol/src/lib/account-ids.ts`). The contract owns them; this file re-exports them for the
 * wire files copied beside it and keeps the two helpers that are not part of the contract.
 */
import type { z } from 'zod';
import {
  type AccountId,
  AccountIdSchema,
  type AccountKey,
  AccountKeySchema,
  type SignInId,
  SignInIdSchema,
  type SignInRuleId,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  SignInRuleStageIdSchema,
  SignInRuleSuggestionIdSchema,
  TaskPlanStageIdSchema,
  type TwoFactorId,
  TwoFactorIdSchema,
  TwoFactorStageIdSchema,
} from '../contract/index.ts';

export type { AccountId, AccountKey, SignInId, SignInRuleId, TwoFactorId };
export {
  AccountIdSchema,
  AccountKeySchema,
  SignInIdSchema,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  SignInRuleStageIdSchema,
  SignInRuleSuggestionIdSchema,
  TaskPlanStageIdSchema,
  TwoFactorIdSchema,
  TwoFactorStageIdSchema,
};

/** Whether a hint names a sign-in by its id rather than an account. */
export const namesSignIn = (hint: string): hint is SignInId => SignInIdSchema.safeParse(hint).success;

export type TwoFactorStageId = z.infer<typeof TwoFactorStageIdSchema>;
export type TaskPlanStageId = z.infer<typeof TaskPlanStageIdSchema>;
/** Typed by its prefix, so a claim for a rule's stored proof can't be handed another act's stage at compile time. */
export type SignInRuleStageId = z.infer<typeof SignInRuleStageIdSchema>;
export type SignInRuleSuggestionId = z.infer<typeof SignInRuleSuggestionIdSchema>;
