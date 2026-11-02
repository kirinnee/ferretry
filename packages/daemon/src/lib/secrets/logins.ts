/**
 * SAVED LOGINS, AS A PROJECTION OF ACCOUNTS (docs/secrets.md, "Accounts and sign-ins"; the wire is
 * `packages/protocol/src/lib/login-entries.ts`).
 *
 * The store is accounts and sign-ins now (`accounts.ts`). What an older app and an older `fy` still
 * read and write is a SAVED LOGIN, so this file keeps that surface for one release, over the new store:
 *
 * - READ: one {@link LoginEntrySummary} per account. `match` is every place it signs in, `domains` its websites' login
 *   domains, and the method, recipe and auto-apply are its PRIMARY sign-in's (its website, else its first terminal).
 * - WRITE: a change to the account (label, username, password, its one seed, a rename, a delete) always works. A change
 *   to WHERE or HOW it signs in (match, domains, method, recipe, auto-apply) maps 1:1 onto the account's one sign-in,
 *   and is REFUSED (`409 account_has_sign_ins`) for an account that signs in at several places: that body cannot say
 *   which one it means, and guessing would be a lossy write.
 *
 * The version 1 index schema stays here, frozen: it is what the boot migration reads, and what an older daemon still
 * reads — and fails closed on, since a version 2 index is not one.
 */

import {
  type AccountId,
  type AccountSummary,
  type LoginEntryId,
  type LoginEntrySummary,
  LOGIN_MATCH_MAX,
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_PROPOSALS_MAX,
  LoginDomainSchema,
  LoginObservedSchema,
  type LoginRecipeProposal,
  LoginRecipeProposalSchema,
  LoginMethodSchema,
  PASSWORD_METHOD,
  type Place,
  placeHosts,
  placeKeys,
  type PutLoginEntry,
  savedLoginPlaces,
  SealedNameSchema,
  type SignInId,
  type SignInRecord,
  type SignInSummary,
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
  accountSummary,
  AccountVault,
  decideOn,
  type LoginFieldValues,
  LoginEntryError,
  type LoginIndexStore,
  type LoginSweep,
  methodRecord,
  primaryFirst,
  signInsOf,
  signInSummary,
  withRecipe,
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
 * An account as a saved login: every place it signs in (its websites' `match` hosts, then each terminal key), its
 * websites' login domains, and its PRIMARY sign-in's method, recipe and auto-apply. Facts and proposals of every
 * sign-in are listed, so the lock and the owner see all of them.
 */
export function savedLoginOf(account: AccountSummary, signIns: readonly SignInSummary[]): LoginEntrySummary {
  const own = signIns.filter(signIn => signIn.account === account.id);
  const sites = own.filter(signIn => signIn.place.kind === 'site');
  const terminals = own.filter(signIn => signIn.place.kind !== 'site');
  const primary = sites[0] ?? terminals[0];
  const match = unique([
    ...sites.flatMap(signIn => (signIn.place as SitePlace).match),
    ...terminals.flatMap(signIn => placeKeys(signIn.place)),
  ]).slice(0, LOGIN_MATCH_MAX);
  const domains = unique(sites.flatMap(signIn => (signIn.place as SitePlace).domains)).slice(0, LOGIN_MATCH_MAX);
  const observed = [...sites, ...terminals].flatMap(signIn => signIn.observed ?? []).slice(-LOGIN_OBSERVED_MAX);
  const proposals = [...sites, ...terminals]
    .flatMap(signIn => signIn.proposals ?? [])
    .slice(-LOGIN_RECIPE_PROPOSALS_MAX);
  return {
    id: account.id,
    label: account.label,
    match,
    method: primary?.method ?? PASSWORD_METHOD,
    domains,
    ...(account.username === undefined ? {} : { username: account.username }),
    fields: account.fields,
    ...(account.totp === undefined ? {} : { totp: account.totp }),
    ...(primary?.recipe === undefined ? {} : { recipe: primary.recipe }),
    ...(primary?.recipe === undefined || primary.recipeBy === undefined ? {} : { recipeBy: primary.recipeBy }),
    ...(primary?.autoApplyRecipe === true ? { autoApplyRecipe: true } : {}),
    ...(observed.length === 0 ? {} : { observed }),
    ...(proposals.length === 0 ? {} : { proposals }),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** The saved login an account in a draft reads as. */
function savedLoginIn(draft: Pick<AccountDraft, 'accounts' | 'signIns'>, id: AccountId): LoginEntrySummary {
  const account = draft.accounts[id];
  if (account === undefined) throw new LoginEntryError('unknown_login', `there is no account ${id}`);
  const own = signInsOf(draft.signIns, account.key).map(([signInId, signIn]) =>
    signInSummary(signInId, signIn, draft.accounts, draft.signIns),
  );
  return savedLoginOf(accountSummary(id, account, draft.signIns), own);
}

/** The parts of a saved-login change that say where or how it signs in: they map onto ONE sign-in. */
const SIGN_IN_FIELDS = ['match', 'domains', 'method', 'recipe', 'autoApplyRecipe'] as const;

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** One sign-in as a saved login's `match` and `domains` (absent: they read as its web `match` hosts). */
function savedLoginShapeOf(place: Place | undefined): { match: readonly string[]; domains?: readonly string[] } {
  if (place === undefined) return { match: [] };
  if (place.kind === 'terminal') return { match: placeKeys(place) };
  return sameList(place.domains, place.match) ? { match: place.match } : { match: place.match, domains: place.domains };
}

/**
 * The saved-login surface over the account store: what the `/v1/secrets/logins*` routes use for one release, and
 * "Save as" on a card. The input bridge's matching, facts and `account.hint` read sign-ins from {@link accounts}. It
 * holds the {@link AccountDirectory} it was built over, so the two always share ONE store lock.
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

  /** Every account as a saved login, by label. Raises `SecretStoreError` when it cannot tell — never an empty list. */
  async list(): Promise<readonly LoginEntrySummary[]> {
    const listing = await this.accounts.list();
    return listing.accounts.map(account => savedLoginOf(account, listing.signIns));
  }

  /**
   * An older client's change (`PUT /v1/secrets/logins/:id`): the account's fields always; where and how it signs in
   * only onto its ONE sign-in. An account that signs in at several places refuses those parts with
   * `account_has_sign_ins`, and nothing is changed.
   */
  async put(id: LoginEntryId, change: PutLoginEntry): Promise<LoginEntrySummary> {
    return await this.accounts.transact(async draft => {
      const existing = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
      const own = existing === undefined ? [] : primaryFirst(signInsOf(draft.signIns, existing.key));
      const touches = SIGN_IN_FIELDS.some(field => change[field] !== undefined);
      if (touches && own.length > 1)
        throw new LoginEntryError(
          'account_has_sign_ins',
          `${existing?.label ?? id} signs in at ${String(own.length)} places; update the app or use \`fy account site …\` to change one`,
        );
      await this.accounts.applyAccount(draft, id, {
        ...(change.label === undefined ? {} : { label: change.label }),
        ...(change.username === undefined ? {} : { username: change.username }),
        ...(change.password === undefined ? {} : { password: change.password }),
      });
      if (change.totp !== undefined)
        await this.accounts.applySeed(
          draft,
          id,
          change.totp === null
            ? null
            : { seed: change.totp.seed, parameters: TotpParametersSchema.parse(change.totp.parameters ?? {}) },
        );
      if (touches) this.reshape(draft, id, own[0], change);
      return savedLoginIn(draft, id);
    });
  }

  /**
   * The account's one sign-in (or none) made into what the changed saved login names, exactly as the migration makes
   * a saved login's places: its website first (the primary, which keeps its id, proposals and auto-apply), then one
   * per terminal key. Facts are kept only at a key of the place they were seen at.
   */
  private reshape(
    draft: AccountDraft,
    id: AccountId,
    current: readonly [SignInId, SignInRecord] | undefined,
    change: PutLoginEntry,
  ): void {
    const account = draft.accounts[id];
    if (account === undefined) return;
    const shape = savedLoginShapeOf(current?.[1].place);
    const places = savedLoginPlaces(
      { match: change.match ?? shape.match, domains: change.domains ?? shape.domains },
      this.accounts.hostName,
    );
    const template = current?.[1];
    // A provider that is gone, or the account itself, is refused before anything else is said about the change.
    const method = change.method === undefined ? template?.method : methodRecord(change.method, draft.accounts, id);
    if (places.length === 0) {
      // Never a lossy write: a method, a recipe or auto-apply the change brings, or the sign-in it would remove still
      // holds, has nowhere to go without a place, so it is refused rather than answered as saved.
      const brings = method !== undefined || typeof change.recipe === 'string' || change.autoApplyRecipe === true;
      const holds =
        template?.recipe !== undefined || template?.proposals !== undefined || template?.method !== undefined;
      if (brings || holds)
        throw new LoginEntryError(
          'no_sign_in',
          `${account.label} would sign in nowhere, and a method or recipe needs a place; name where it signs in`,
        );
      if (current !== undefined) delete draft.signIns[current[0]];
      return;
    }
    if (places.length > MAX_SIGN_INS_PER_ACCOUNT)
      throw new LoginEntryError(
        'invalid_change',
        `an account has at most ${String(MAX_SIGN_INS_PER_ACCOUNT)} sign-ins`,
      );
    places.forEach((place, index) => {
      const primary = index === 0;
      const signInId = primary && current !== undefined ? current[0] : this.accounts.freshSignInId(draft);
      const base: SignInRecord = template ?? {
        account: account.key,
        place,
        createdAt: draft.at,
        updatedAt: draft.at,
      };
      const recipe = withRecipe(base, change.recipe, draft.at);
      const { method: _method, autoApplyRecipe: _auto, observed: _observed, proposals: _proposals, ...rest } = recipe;
      const observed = (base.observed ?? []).filter(fact => placeKeys(place).includes(fact.at));
      const autoApply = primary && (change.autoApplyRecipe ?? base.autoApplyRecipe === true);
      draft.signIns[signInId] = {
        ...rest,
        account: account.key,
        place,
        ...(method === undefined ? {} : { method }),
        ...(autoApply ? { autoApplyRecipe: true as const } : {}),
        ...(observed.length === 0 ? {} : { observed }),
        ...(primary && base.proposals !== undefined ? { proposals: base.proposals } : {}),
        createdAt: primary ? base.createdAt : draft.at,
        updatedAt: draft.at,
      };
    });
  }

  /**
   * Keeps typed values in an account in ONE change ("Save as" on a card): a new account labelled `label`, or the
   * existing one (its label kept). The place it was typed at is added when the account does not sign in there yet: to
   * its website for a web host (as a saved login's `match` grew), else as a sign-in of its own. The username and the
   * password of one login card are kept together or not at all.
   *
   * `mode` is the owner's choice, checked UNDER THE STORE LOCK so a card raised before another saved cannot write over
   * it: `new` refuses a handle an account already has, `update` refuses one no account has, and refuses a username
   * that is not the account's own (it is someone else: a new account). Absent: either, as before.
   */
  async saveFields(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: LoginFieldValues,
    mode?: 'new' | 'update',
  ): Promise<LoginEntrySummary> {
    return await this.accounts.transact(async draft => {
      const existing = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
      if (mode === 'new' && existing !== undefined)
        throw new LoginEntryError('login_exists', `${id} is already an account's CLI name`);
      if (mode === 'update' && existing === undefined)
        throw new LoginEntryError('unknown_login', `there is no account ${id} to update`);
      const had = existing?.username?.trim().toLowerCase();
      if (
        mode === 'update' &&
        fields.username !== undefined &&
        had !== undefined &&
        had !== fields.username.trim().toLowerCase()
      )
        throw new LoginEntryError('invalid_change', `${id} has another username; save it as a new account`);
      const account = await this.accounts.applyAccount(draft, id, {
        ...(existing === undefined ? { label } : {}),
        ...(fields.username === undefined ? {} : { username: fields.username }),
        ...(fields.password === undefined ? {} : { password: fields.password }),
      });
      if (match !== undefined) this.addPlace(draft, account.key, match);
      return savedLoginIn(draft, id);
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

  /** The account's sign-in that holds a proposal: proposal ids are unique, so it is one or none. */
  private holding(draft: AccountDraft, id: LoginEntryId, proposalId: string) {
    const account = this.accounts.accountIn(draft, id);
    return signInsOf(draft.signIns, account.key).find(
      ([, signIn]) => signIn.proposals?.some(proposal => proposal.id === proposalId) === true,
    );
  }

  /** The owner's answer to a proposal, found by its id on whichever of the account's sign-ins holds it. */
  async decide(
    id: LoginEntryId,
    proposalId: string,
    decision: 'approve' | 'decline',
  ): Promise<{ readonly entry: LoginEntrySummary; readonly proposal: LoginRecipeProposal }> {
    return await this.accounts.transact(draft => {
      const found = this.holding(draft, id, proposalId);
      if (found === undefined)
        throw new LoginEntryError(
          'unknown_proposal',
          `${id} has no recipe proposal ${proposalId}; it was answered or replaced`,
        );
      const { proposal } = decideOn(draft, found[0], found[1], proposalId, decision);
      return { entry: savedLoginIn(draft, id), proposal };
    });
  }

  /** A new handle for an account. Its sealed values stay where they are, filed under its key. */
  async rename(from: LoginEntryId, to: LoginEntryId): Promise<LoginEntrySummary> {
    await this.accounts.renameAccount(from, to);
    return (await this.list()).find(entry => entry.id === to) as LoginEntrySummary;
  }

  /** Removes an account and every sign-in it has. */
  async remove(id: LoginEntryId): Promise<boolean> {
    return await this.accounts.removeAccount(id);
  }

  /** AT BOOT: the account store's boot step (migrate, then sweep). See {@link AccountDirectory.prepare}. */
  async sweepUnreferenced(): Promise<LoginSweep> {
    return await this.accounts.prepare();
  }
}

/** The plaintext side, under its saved-login name for the input bridge and the redactor. */
export class LoginVault extends AccountVault {}
