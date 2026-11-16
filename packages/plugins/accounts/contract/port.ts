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
  /**
   * Whether anything of the owner's is open on this ferret — an input card they have not answered, a sign-in waiting
   * for their phone, a plan card, a secret the ferret copied — so the Warden does not move it and throw that away. ONE yes
   * or no: no card, account, id or value crosses it. FAILS CLOSED: a read that cannot be made answers `true`. Additive: a
   * provider without it leaves the Warden unable to say, and the Warden then moves nothing.
   */
  ownerHold?(ferret: string): boolean;
}

export const AccountsPort = definePort<AccountsApi>('accounts');

/** A sign-in was added, changed or removed, or a standing rule moved. Read the port for the truth. */
export const SignInsChanged = defineEvent(
  'accounts.sign-ins-changed',
  z.strictObject({ signIn: SignInIdSchema.optional(), change: z.enum(['sign-in', 'rule', 'recipe', 'factor']) }),
);
