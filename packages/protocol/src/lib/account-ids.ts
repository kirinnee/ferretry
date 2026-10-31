import { z } from 'zod';
import { SecretNameSchema } from './secrets.ts';

/**
 * THE NAMES OF AN ACCOUNT AND OF A SIGN-IN (docs/input-requests.md, "Accounts and sign-ins").
 *
 * Their own file, apart from `accounts.ts`, only so `login-entries.ts` (the card's offers) and `input-request.ts`
 * (a raise's hint, a deliver's sign-in) can name a sign-in without importing the module that imports them.
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
