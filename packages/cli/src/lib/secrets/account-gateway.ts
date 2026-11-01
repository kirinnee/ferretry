import {
  type AccountHintList,
  AccountHintListSchema,
  type AccountList,
  AccountListSchema,
  type AccountLookAlike,
  AccountLookAlikeSchema,
  AccountPairRequestSchema,
  type AccountSummary,
  AccountSummarySchema,
  type AddSignInRequest,
  AddSignInRequestSchema,
  type AddTwoFactorKeyRequest,
  AddTwoFactorKeyRequestSchema,
  type LoginRecipeDecision,
  LoginRecipeDecisionSchema,
  type PutAccountDefaultRequest,
  PutAccountDefaultRequestSchema,
  type PutAccountDefaultResult,
  PutAccountDefaultResultSchema,
  type PutAccountRequest,
  PutAccountRequestSchema,
  type PutSignInRequest,
  PutSignInRequestSchema,
  type RemovedAccount,
  RemovedAccountSchema,
  type RemovedSignIn,
  RemovedSignInSchema,
  type RemovedTwoFactorKey,
  RemovedTwoFactorKeySchema,
  RenameAccountRequestSchema,
  type SignInSummary,
  SignInSummarySchema,
  type TwoFactorKeySummary,
  TwoFactorKeySummarySchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { AccountApiClient, IAccountGateway } from './account-ports.ts';

/** The daemon's account surface, beside the secret store it is sealed in. */
const ACCOUNTS_PATH = '/v1/accounts';

const accountPath = (id: string): string => `${ACCOUNTS_PATH}/${encodeURIComponent(id)}`;
const signInPath = (id: string): string => `${ACCOUNTS_PATH}/sign-ins/${encodeURIComponent(id)}`;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A daemon that has no accounts routes at all: its `404 unknown_route`, told apart from "no such account" (`not_found`). */
export const OLD_DAEMON_MESSAGE =
  'this daemon is older than accounts and sign-ins and has no /v1/accounts routes: update it (fy daemon update), then run this again';

/** What the daemon's `403 owner_only` means for a ferret on a person route, in the owner's words. No other credential is tried. */
export const OWNER_ONLY_MESSAGE =
  "the daemon refused this: changing accounts is the OWNER's, not a ferret's. Run it yourself at your own shell (or in the Ferretry app). Nothing was changed, and no other credential was tried";

/** The two answers every account route can give regardless of what was asked, said once. */
export function accountRefusal(error: unknown): unknown {
  if (!(error instanceof FyHttpError)) return error;
  if (error.status === 404 && error.code === 'unknown_route') return new Error(OLD_DAEMON_MESSAGE);
  if (error.status === 403 && error.code === 'owner_only') return new Error(`${OWNER_ONLY_MESSAGE} (${error.message})`);
  return error;
}

/**
 * Speaks the account routes through the protocol client. Bodies are parsed against the protocol schemas in both
 * directions; nothing here logs one, and no reply carries a value. A 404 `unknown_route` (the routes are missing) and a
 * 403 `owner_only` (a ferret on a person route) are turned into their one clear sentence here; every other refusal,
 * a different 403 included, reaches the controller as the daemon's {@link FyHttpError}, code and all.
 */
export class ProtocolAccountGateway implements IAccountGateway {
  constructor(private readonly client: AccountApiClient) {}

  async list(): Promise<AccountList> {
    return await this.#guard(() => this.client.request(ACCOUNTS_PATH, AccountListSchema));
  }

  async putAccount(id: string, body: PutAccountRequest): Promise<AccountSummary> {
    const json = JSON.stringify(PutAccountRequestSchema.parse(body));
    return await this.#guard(() =>
      this.client.request(accountPath(id), AccountSummarySchema, { method: 'PUT', headers: JSON_HEADERS, body: json }),
    );
  }

  async renameAccount(id: string, to: string): Promise<AccountSummary> {
    const json = JSON.stringify(RenameAccountRequestSchema.parse({ to }));
    return await this.#guard(() =>
      this.client.request(`${accountPath(id)}/rename`, AccountSummarySchema, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async removeAccount(id: string): Promise<RemovedAccount> {
    return await this.#guard(() => this.client.request(accountPath(id), RemovedAccountSchema, { method: 'DELETE' }));
  }

  async merge(id: string, from: string): Promise<AccountSummary> {
    const json = JSON.stringify(AccountPairRequestSchema.parse({ from }));
    return await this.#guard(() =>
      this.client.request(`${accountPath(id)}/merge`, AccountSummarySchema, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async apart(id: string, from: string): Promise<AccountSummary> {
    const json = JSON.stringify(AccountPairRequestSchema.parse({ from }));
    return await this.#guard(() =>
      this.client.request(`${accountPath(id)}/apart`, AccountSummarySchema, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async lookAlike(): Promise<AccountLookAlike> {
    return await this.#guard(() => this.client.request(`${ACCOUNTS_PATH}/look-alike`, AccountLookAlikeSchema));
  }

  async hint(site: string): Promise<AccountHintList> {
    return await this.#guard(() =>
      this.client.request(`${ACCOUNTS_PATH}/hint?site=${encodeURIComponent(site)}`, AccountHintListSchema),
    );
  }

  async addSignIn(account: string, body: AddSignInRequest): Promise<SignInSummary> {
    const json = JSON.stringify(AddSignInRequestSchema.parse(body));
    return await this.#guard(() =>
      this.client.request(`${accountPath(account)}/sign-ins`, SignInSummarySchema, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async putSignIn(signIn: string, body: PutSignInRequest): Promise<SignInSummary> {
    const json = JSON.stringify(PutSignInRequestSchema.parse(body));
    return await this.#guard(() =>
      this.client.request(signInPath(signIn), SignInSummarySchema, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async removeSignIn(signIn: string): Promise<RemovedSignIn> {
    return await this.#guard(() => this.client.request(signInPath(signIn), RemovedSignInSchema, { method: 'DELETE' }));
  }

  async decideRecipe(
    signIn: string,
    proposalId: string,
    decision: LoginRecipeDecision['decision'],
  ): Promise<SignInSummary> {
    const json = JSON.stringify(LoginRecipeDecisionSchema.parse({ decision }));
    return await this.#guard(() =>
      this.client.request(
        `${signInPath(signIn)}/recipe/proposals/${encodeURIComponent(proposalId)}`,
        SignInSummarySchema,
        { method: 'POST', headers: JSON_HEADERS, body: json },
      ),
    );
  }

  async putDefault(body: PutAccountDefaultRequest): Promise<PutAccountDefaultResult> {
    const json = JSON.stringify(PutAccountDefaultRequestSchema.parse(body));
    return await this.#guard(() =>
      this.client.request(`${ACCOUNTS_PATH}/defaults`, PutAccountDefaultResultSchema, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async addFactor(account: string, body: AddTwoFactorKeyRequest): Promise<TwoFactorKeySummary> {
    const json = JSON.stringify(AddTwoFactorKeyRequestSchema.parse(body));
    return await this.#guard(() =>
      this.client.request(`${accountPath(account)}/factors`, TwoFactorKeySummarySchema, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: json,
      }),
    );
  }

  async removeFactor(account: string, factor: string): Promise<RemovedTwoFactorKey> {
    return await this.#guard(() =>
      this.client.request(`${accountPath(account)}/factors/${encodeURIComponent(factor)}`, RemovedTwoFactorKeySchema, {
        method: 'DELETE',
      }),
    );
  }

  async #guard<T>(dial: () => Promise<T>): Promise<T> {
    try {
      return await dial();
    } catch (error) {
      throw accountRefusal(error);
    }
  }
}
