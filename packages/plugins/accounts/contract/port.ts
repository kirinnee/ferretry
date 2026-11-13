/**
 * Accounts' port (§2.3): which sign-ins match a place, by id and account, for a plugin that offers one on a card.
 * Never a value: a fill is the Vault's, typed into a target it verified.
 */
import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type PlaceKey, SignInIdSchema, type SignInSummary } from './wire.ts';

export interface AccountsApi {
  /** The sign-ins saved for one place key (a login domain, a site's match host or a `tool@host`). */
  signInsFor(place: PlaceKey): Promise<readonly SignInSummary[]>;
}

export const AccountsPort = definePort<AccountsApi>('accounts');

/** A sign-in was added, changed or removed, or a standing rule moved. Read the port for the truth. */
export const SignInsChanged = defineEvent(
  'accounts.sign-ins-changed',
  z.strictObject({ signIn: SignInIdSchema.optional(), change: z.enum(['sign-in', 'rule', 'recipe', 'factor']) }),
);
