/**
 * THE ACCOUNT STORE UNDER ITS INPUT-BRIDGE NAME (docs/secrets.md, "Accounts and sign-ins").
 *
 * {@link LoginDirectory} is what the input bridge holds: the {@link AccountDirectory} for the listing, and "Save as" on
 * a card (`saveFields`). The version 1 index schema stays here, frozen: it is what the boot migration reads, and what
 * an older daemon still reads — and fails closed on, since a version 2 index is not one.
 */

import {
  type LoginEntryId,
  LOGIN_MATCH_MAX,
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_PROPOSALS_MAX,
  LoginDomainSchema,
  LoginObservedSchema,
  LoginRecipeProposalSchema,
  LoginMethodSchema,
  placeHosts,
  savedLoginPlaces,
  SealedNameSchema,
  type SitePlace,
  MAX_SIGN_INS_PER_ACCOUNT,
  TotpParametersSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { ClockPort } from '../ports.ts';
import {
  type AccountDirectoryOptions,
  type AccountDraft,
  AccountDirectory,
  AccountVault,
  type LoginFieldValues,
  LoginEntryError,
  type LoginIndexStore,
  type LoginSweep,
  signInsOf,
} from './accounts.ts';
import type { SecretCipherPort, SecretDocumentStore } from './types.ts';

/** One saved login as a VERSION 1 index keeps it. Frozen: the migration reads it, and nothing writes it any more. */
export const LoginRecordSchema = z.strictObject({
  key: z.string().regex(/^L[0-9A-F]{24}$/u),
  label: z.string().min(1).max(80),
  match: z.array(z.string().min(1).max(320)).max(16),
  method: LoginMethodSchema.optional(),
  domains: z.array(LoginDomainSchema).max(16).optional(),
  username: z.string().min(1).max(256).optional(),
  seals: z.strictObject({
    password: SealedNameSchema.optional(),
    totp: SealedNameSchema.optional(),
  }),
  totp: TotpParametersSchema.optional(),
  recipe: z.string().min(1).max(4_000).optional(),
  autoApplyRecipe: z.literal(true).optional(),
  recipeBy: z.literal('ferret').optional(),
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).optional(),
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoginRecord = z.infer<typeof LoginRecordSchema>;

/** A version 1 index. `v` is a literal: a version 2 index is not one, so a reader of only this fails closed. */
export const LoginIndexDocumentSchema = z.strictObject({
  v: z.literal(1),
  entries: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), LoginRecordSchema),
});
export type LoginIndexDocument = z.infer<typeof LoginIndexDocumentSchema>;

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * The account store as the input bridge uses it: {@link accounts} for the listing (matching, facts and
 * `account.hint` read sign-ins from it), {@link saveFields} for "Save as" on a card, and {@link sweepUnreferenced} for
 * the boot step. It holds the {@link AccountDirectory} it was built over, so they always share ONE store lock.
 */
export class LoginDirectory {
  readonly accounts: AccountDirectory;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    clock: ClockPort,
    options: AccountDirectoryOptions = {},
  ) {
    this.accounts = new AccountDirectory(index, sealed, cipher, clock, options);
  }

  /**
   * Keeps typed values in an account in ONE change ("Save as" on a card): a new account labelled `label`, or the
   * existing one (its label kept). The place it was typed at is added when the account does not sign in there yet: to
   * its website for a web host (as a saved login's `match` grew), else as a sign-in of its own. The username and the
   * password of one login card are kept together or not at all.
   *
   * `mode` is the owner's choice, checked UNDER THE STORE LOCK so a card raised before another saved cannot write over
   * it: `new` refuses a handle an account already has, `update` refuses one no account has, and refuses another person:
   * a username that is not the account's own, or a page (`pageUsername`, what the ferret typed there) signing in someone
   * the account is not — including an account with no username saved, which nothing says is the same person. Absent
   * `mode`: either, as before (the input service always names one; the CLI and Settings write accounts their own way).
   */
  async saveFields(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: LoginFieldValues,
    mode?: 'new' | 'update',
    pageUsername?: string,
  ): Promise<void> {
    await this.accounts.transact(async draft => {
      const existing = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
      if (mode === 'new' && existing !== undefined)
        throw new LoginEntryError('login_exists', `${id} is already an account's CLI name`);
      if (mode === 'update' && existing === undefined)
        throw new LoginEntryError('unknown_login', `there is no account ${id} to update`);
      const had = existing?.username?.trim().toLowerCase();
      const otherBox =
        fields.username !== undefined && had !== undefined && had !== fields.username.trim().toLowerCase();
      const otherPage = pageUsername !== undefined && had !== pageUsername.trim().toLowerCase();
      if (mode === 'update' && (otherBox || otherPage))
        throw new LoginEntryError('invalid_change', `${id} is someone else; save it as a new account`);
      const account = await this.accounts.applyAccount(draft, id, {
        ...(existing === undefined ? { label } : {}),
        ...(fields.username === undefined ? {} : { username: fields.username }),
        ...(fields.password === undefined ? {} : { password: fields.password }),
      });
      if (match !== undefined) this.addPlace(draft, account.key, match);
    });
  }

  private addPlace(draft: AccountDraft, key: string, match: string): void {
    const own = signInsOf(draft.signIns, key);
    if (own.some(([, signIn]) => placeHosts(signIn.place).includes(match))) return;
    const [place] = savedLoginPlaces({ match: [match] }, this.accounts.hostName);
    if (place === undefined) return;
    const site = own.find(([, signIn]) => signIn.place.kind === 'site');
    if (place.kind === 'site' && site !== undefined) {
      const [siteId, signIn] = site;
      const at = signIn.place as SitePlace;
      draft.signIns[siteId] = {
        ...signIn,
        place: {
          kind: 'site',
          domains: unique([...at.domains, match]).slice(-LOGIN_MATCH_MAX),
          match: unique([...at.match, match]).slice(-LOGIN_MATCH_MAX),
        },
        updatedAt: draft.at,
      };
      return;
    }
    if (own.length >= MAX_SIGN_INS_PER_ACCOUNT) return;
    draft.signIns[this.accounts.freshSignInId(draft)] = {
      account: key,
      place,
      createdAt: draft.at,
      updatedAt: draft.at,
    };
  }

  /** AT BOOT: the account store's boot step (migrate, then sweep). See {@link AccountDirectory.prepare}. */
  async sweepUnreferenced(): Promise<LoginSweep> {
    return await this.accounts.prepare();
  }
}

/** The plaintext side, under its saved-login name for the input bridge and the redactor. */
export class LoginVault extends AccountVault {}
