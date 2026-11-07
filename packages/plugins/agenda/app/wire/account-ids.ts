import { z } from 'zod';

/**
 * The account and sign-in ids an ask may name (today's `protocol/src/lib/account-ids.ts`, the part Asks reads). The
 * sign-in approval itself is the Accounts plugin's (`ask.sources: sign-in-approval`); an ask only carries its ids.
 */

/** An account's handle: a saved login's handle, unchanged. */
export const AccountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u, 'an account handle is uppercase letters, digits and underscores');

/** A STAGED 2FA seed (`st_` and 24 hex digits): one save waiting for its passkey, held in the daemon's memory only. */
export const TwoFactorStageIdSchema = z
  .string()
  .regex(/^st_[0-9a-f]{24}$/u, 'a staged 2FA key is st_ and 24 hex digits');

/** A STANDING SIGN-IN RULE (`sr_` and 24 hex digits): the owner's passkey-signed permission to fill one sign-in. */
export const SignInRuleIdSchema = z
  .string()
  .regex(/^sr_[0-9a-f]{24}$/u, 'a standing sign-in rule is sr_ and 24 hex digits');

/** A FERRET'S SUGGESTION of a standing rule (`srg_` and 16 hex digits): it can never become a rule by itself. */
export const SignInRuleSuggestionIdSchema = z
  .string()
  .regex(/^srg_[0-9a-f]{16}$/u, 'a standing rule suggestion is srg_ and 16 hex digits');
