import { z } from 'zod';
import { SecretNameSchema } from './secrets.ts';

/**
 * THE NAMES OF AN ACCOUNT AND OF A SIGN-IN (docs/input-requests.md, "Accounts and sign-ins").
 *
 * Their own file, apart from `accounts.ts`, only so `login-entries.ts` (the card's offers) and `input-request.ts`
 * (a raise's hint, a deliver's sign-in) can name a sign-in without importing the module that imports them. The ids of
 * a 2FA key and of a staged seed live here for the same reason (a raise and a deliver name a key; a step-up names a
 * stage).
 *
 * - An ACCOUNT's id is the handle people and recipes read (`GITHUB_KIRINNEE`, `[[GITHUB_KIRINNEE]]`): today's saved
 *   login handle, the same shape, and renameable. Behind it sits an immutable KEY (`L…`) that never changes, so a
 *   rename moves nothing that is sealed and nothing that points at the account.
 * - A SIGN-IN's id (`si_` and 16 hex digits) is immutable and never renamed, because it is what a plan line or a
 *   standing rule pins.
 */

/** An account's handle: a saved login's handle, unchanged. */
export const AccountIdSchema = SecretNameSchema;
export type AccountId = z.infer<typeof AccountIdSchema>;

/** An account's immutable key: today's saved login key, which every sealed name starts with. Never on a card. */
export const AccountKeySchema = z.string().regex(/^L[0-9A-F]{24}$/u, 'an account key is L and 24 hex digits');
export type AccountKey = z.infer<typeof AccountKeySchema>;

/** A sign-in's id: `si_` and 16 lowercase hex digits. Random on create; derived on migration (accounts.ts). */
export const SignInIdSchema = z.string().regex(/^si_[0-9a-f]{16}$/u, 'a sign-in id is si_ and 16 hex digits');
export type SignInId = z.infer<typeof SignInIdSchema>;

/** Whether a ferret's `secretHint` names a sign-in (`si_…`) rather than an account handle. */
export const namesSignIn = (hint: string): hint is SignInId => SignInIdSchema.safeParse(hint).success;

/**
 * A 2FA key's id: `tf_` and 12 lowercase hex digits. Immutable and never shown to people (the CLI and plan lines
 * only): a card names a key by its owner-written label. Random on add; derived on migration (accounts.ts).
 */
export const TwoFactorIdSchema = z.string().regex(/^tf_[0-9a-f]{12}$/u, 'a 2FA key id is tf_ and 12 hex digits');
export type TwoFactorId = z.infer<typeof TwoFactorIdSchema>;

/**
 * A STAGED 2FA seed (`st_` and 24 hex digits): one save waiting for its passkey, held in the daemon's memory only.
 * A passkey proof for `add-2fa-key` is bound to exactly one, so it cannot be spent on another save.
 */
export const TwoFactorStageIdSchema = z
  .string()
  .regex(/^st_[0-9a-f]{24}$/u, 'a staged 2FA key is st_ and 24 hex digits');
export type TwoFactorStageId = z.infer<typeof TwoFactorStageIdSchema>;

/**
 * A STAGED TASK-PLAN APPROVAL (`tps_` and 24 hex digits): the lines the owner ticked on a task plan, waiting for the
 * passkey, held in the daemon's memory only (task-plan.ts). A passkey proof for `approve-task-plan` is bound to exactly
 * one, so it cannot be spent on another selection. Here beside the 2FA stage for the same reason: a step-up names it.
 */
export const TaskPlanStageIdSchema = z
  .string()
  .regex(/^tps_[0-9a-f]{24}$/u, 'a staged task-plan approval is tps_ and 24 hex digits');
export type TaskPlanStageId = z.infer<typeof TaskPlanStageIdSchema>;

/**
 * A STANDING SIGN-IN RULE (`sr_` and 24 hex digits, sign-in-rules.ts): the owner's passkey-signed permission to fill one
 * sign-in for any ferret, until it expires. Kept on disk. Its id survives a resume, renew or widen (`revision` + 1).
 */
export const SignInRuleIdSchema = z
  .string()
  .regex(/^sr_[0-9a-f]{24}$/u, 'a standing sign-in rule is sr_ and 24 hex digits');
export type SignInRuleId = z.infer<typeof SignInRuleIdSchema>;

/**
 * A STAGED STANDING RULE (`srs_` and 24 hex digits): one rule body waiting for its passkey, held in the daemon's memory
 * only. A passkey proof for `approve-sign-in-rule` is bound to exactly one (`signInRuleSubject`), so it cannot be spent
 * on another body. Here beside the other stages for the same reason: a step-up names it.
 */
export const SignInRuleStageIdSchema = z
  .string()
  .regex(/^srs_[0-9a-f]{24}$/u, 'a staged standing rule is srs_ and 24 hex digits');
export type SignInRuleStageId = z.infer<typeof SignInRuleStageIdSchema>;

/**
 * A FERRET'S SUGGESTION of a standing rule (`srg_` and 16 hex digits): an agenda card that opens the owner's create
 * sheet with nothing ticked. It holds no stage, no proof and no fields, so it can never become a rule by itself.
 */
export const SignInRuleSuggestionIdSchema = z
  .string()
  .regex(/^srg_[0-9a-f]{16}$/u, 'a standing rule suggestion is srg_ and 16 hex digits');
export type SignInRuleSuggestionId = z.infer<typeof SignInRuleSuggestionIdSchema>;

/** A standing rule's revision: 1 when created, one more on each resume, renew or widen. Part of the signed bytes. */
export const SignInRuleRevisionSchema = z.number().int().min(1).max(1_000_000);
