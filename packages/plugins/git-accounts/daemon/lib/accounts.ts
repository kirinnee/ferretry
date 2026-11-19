/**
 * The account book: who is connected (in the clear, `accounts.json`) and each account's token (sealed, `tokens.json`).
 * `token()` is the one place a token is read; it is handed to nothing but `GithubAccounts.api` and the device flow's
 * first look at `/user`, which put it on a request to `api.github.com` and let it go.
 */
import type { StatePort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import type { SealedDocumentHandle, SealedName } from '@ferretry/core-vault/contract';
import {
  GIT_ACCOUNT_CODES,
  GitAccountsState,
  type GitAccount,
  type GitAccountId,
  type GitAccountKeys,
} from '../../contract/index.ts';

export interface AccountFacts {
  readonly id: GitAccountId;
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly scopes: readonly string[];
}

export class AccountBook {
  constructor(
    private readonly state: StatePort,
    private readonly tokens: SealedDocumentHandle,
    private readonly now: () => string,
  ) {}

  async list(): Promise<readonly GitAccount[]> {
    const read = await this.state.read(GitAccountsState);
    if (!read.ok) throw new ApiError(500, 'the Git accounts file could not be read', 'store_damaged');
    return read.value?.accounts ?? [];
  }

  async find(id: GitAccountId): Promise<GitAccount | undefined> {
    return (await this.list()).find(account => account.id === id);
  }

  /** Adds an account, or, for one already connected, replaces its token and facts and keeps its keys and date. */
  async upsert(facts: AccountFacts, token: string): Promise<GitAccount> {
    const name = facts.id as SealedName;
    const before = await this.tokens.get(name);
    await this.tokens.put(name, token);
    try {
      return await this.#record(facts);
    } catch (error) {
      // The record did not land: put the sealed entry back as it was (an old token) or remove it (a new account), so
      // no token is left that nothing names.
      await (before === undefined ? this.tokens.delete(name) : this.tokens.put(name, before)).catch(() => undefined);
      throw error;
    }
  }

  async #record(facts: AccountFacts): Promise<GitAccount> {
    let stored: GitAccount | undefined;
    const done = await this.state.update(GitAccountsState, current => {
      const accounts = current?.accounts ?? [];
      const before = accounts.find(account => account.id === facts.id);
      stored = {
        id: facts.id,
        provider: 'github',
        githubId: facts.githubId,
        login: facts.login,
        ...(facts.name === undefined ? {} : { name: facts.name }),
        ...(facts.avatarUrl === undefined ? {} : { avatarUrl: facts.avatarUrl }),
        scopes: [...facts.scopes],
        keys: before?.keys ?? {},
        createdAt: before?.createdAt ?? this.now(),
      };
      const kept = accounts.filter(account => account.id !== facts.id);
      return { format: 1 as const, accounts: [...kept, stored] };
    });
    if (!done.ok || stored === undefined)
      throw new ApiError(500, 'the Git accounts file could not be written', 'store_damaged');
    return stored;
  }

  async recordKeys(id: GitAccountId, keys: GitAccountKeys): Promise<void> {
    let found = false;
    const done = await this.state.update(GitAccountsState, current => {
      const accounts = (current?.accounts ?? []).map(account => {
        if (account.id !== id) return account;
        found = true;
        return { ...account, keys };
      });
      return { format: 1 as const, accounts };
    });
    if (!done.ok) throw new ApiError(500, 'the Git accounts file could not be written', 'store_damaged');
    if (!found) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
  }

  /** The token, for the one caller that puts it on an `api.github.com` request. Never returned from a route. */
  async token(id: GitAccountId): Promise<string | undefined> {
    return await this.tokens.get(id as SealedName);
  }

  /** Forgets the sealed token first, then the record: a record with no token is harmless, a token with no record is not. */
  async forget(id: GitAccountId): Promise<void> {
    await this.tokens.delete(id as SealedName);
    const done = await this.state.update(GitAccountsState, current => ({
      format: 1 as const,
      accounts: (current?.accounts ?? []).filter(account => account.id !== id),
    }));
    if (!done.ok) throw new ApiError(500, 'the Git accounts file could not be written', 'store_damaged');
  }
}
