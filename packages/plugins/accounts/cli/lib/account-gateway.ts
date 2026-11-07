import type { z } from 'zod';
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
} from '../../contract/routes/index.ts';
import { callDaemon, type DaemonCallInit, FyHttpError } from '../shell.ts';
import type { AccountApiClient, IAccountGateway } from './account-ports.ts';

/**
 * What the daemon's `403 owner_only` means for a ferret on a person route, in the owner's words. Neutral on purpose:
 * a read (`account ls`) is refused there as well as a change. No other credential is tried.
 */
export const OWNER_ONLY_MESSAGE =
  "the daemon refused this: this is the owner's command, and it ran with a ferret's credential. Run it yourself at your own shell (or in the Ferretry app). Nothing was changed, and no other credential was tried";

/** The one answer every account route can give regardless of what was asked, said once. */
export function accountRefusal(error: unknown): unknown {
  if (!(error instanceof FyHttpError)) return error;
  if (error.status === 403 && error.code === 'owner_only') return new Error(`${OWNER_ONLY_MESSAGE} (${error.message})`);
  return error;
}

/**
 * Speaks the account routes through the plugin client, by the manifest's route keys (today's `ProtocolAccountGateway`
 * over the HTTP client). Bodies are parsed against the wire schemas in both directions; nothing here logs one, and no
 * reply carries a value. A 403 `owner_only` (a ferret on a person route) is turned into its one clear sentence here;
 * every other refusal reaches the controller as the daemon's {@link FyHttpError}, code and all.
 */
export class ProtocolAccountGateway implements IAccountGateway {
  constructor(private readonly client: AccountApiClient) {}

  async list(): Promise<AccountList> {
    return await this.#call('GET /v1/accounts', AccountListSchema);
  }

  async putAccount(id: string, body: PutAccountRequest): Promise<AccountSummary> {
    return await this.#call('PUT /v1/accounts/:id', AccountSummarySchema, {
      params: { id },
      body: PutAccountRequestSchema.parse(body),
    });
  }

  async renameAccount(id: string, to: string): Promise<AccountSummary> {
    return await this.#call('POST /v1/accounts/:id/rename', AccountSummarySchema, {
      params: { id },
      body: RenameAccountRequestSchema.parse({ to }),
    });
  }

  async removeAccount(id: string): Promise<RemovedAccount> {
    return await this.#call('DELETE /v1/accounts/:id', RemovedAccountSchema, { params: { id } });
  }

  async merge(id: string, from: string): Promise<AccountSummary> {
    return await this.#call('POST /v1/accounts/:id/merge', AccountSummarySchema, {
      params: { id },
      body: AccountPairRequestSchema.parse({ from }),
    });
  }

  async apart(id: string, from: string): Promise<AccountSummary> {
    return await this.#call('POST /v1/accounts/:id/apart', AccountSummarySchema, {
      params: { id },
      body: AccountPairRequestSchema.parse({ from }),
    });
  }

  async lookAlike(): Promise<AccountLookAlike> {
    return await this.#call('GET /v1/accounts/look-alike', AccountLookAlikeSchema);
  }

  async hint(site: string): Promise<AccountHintList> {
    return await this.#call('GET /v1/accounts/hint', AccountHintListSchema, { query: { site } });
  }

  async addSignIn(account: string, body: AddSignInRequest): Promise<SignInSummary> {
    return await this.#call('POST /v1/accounts/:id/sign-ins', SignInSummarySchema, {
      params: { id: account },
      body: AddSignInRequestSchema.parse(body),
    });
  }

  async putSignIn(signIn: string, body: PutSignInRequest): Promise<SignInSummary> {
    return await this.#call('PUT /v1/accounts/sign-ins/:signIn', SignInSummarySchema, {
      params: { signIn },
      body: PutSignInRequestSchema.parse(body),
    });
  }

  async removeSignIn(signIn: string): Promise<RemovedSignIn> {
    return await this.#call('DELETE /v1/accounts/sign-ins/:signIn', RemovedSignInSchema, { params: { signIn } });
  }

  async putDefault(body: PutAccountDefaultRequest): Promise<PutAccountDefaultResult> {
    return await this.#call('PUT /v1/accounts/defaults', PutAccountDefaultResultSchema, {
      body: PutAccountDefaultRequestSchema.parse(body),
    });
  }

  async addFactor(account: string, body: AddTwoFactorKeyRequest): Promise<TwoFactorKeySummary> {
    return await this.#call('POST /v1/accounts/:id/factors', TwoFactorKeySummarySchema, {
      params: { id: account },
      body: AddTwoFactorKeyRequestSchema.parse(body),
    });
  }

  async removeFactor(account: string, factor: string): Promise<RemovedTwoFactorKey> {
    return await this.#call('DELETE /v1/accounts/:id/factors/:factor', RemovedTwoFactorKeySchema, {
      params: { id: account, factor },
    });
  }

  async #call<T>(route: string, schema: z.ZodType<T>, init?: DaemonCallInit): Promise<T> {
    try {
      return schema.parse(await callDaemon(this.client, route, init));
    } catch (error) {
      throw accountRefusal(error);
    }
  }
}
