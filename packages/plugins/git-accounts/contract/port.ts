import { definePort } from '@ferretry/kernel/contract';
import type { GitAccount, GitAccountId, GitAccountKeys } from './wire.ts';

/**
 * A call to the provider's API made WITH an account's token, by the daemon half, for another plugin's daemon half (the
 * SSH key registration, B3). The token is placed on the request and never comes back: the answer is the provider's
 * status and JSON body, and the method and path must pass `GITHUB_API_RULES`. Anything else is refused.
 */
export interface GitApiCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** An absolute API path such as `/user/keys` or `/graphql`; a plain query (`?per_page=100&page=2`) may follow it. */
  readonly path: string;
  readonly body?: unknown;
  /** A conditional GET: the `ETag` of the last answer. An unchanged resource answers 304 with no body. */
  readonly ifNoneMatch?: string;
}
/** The response headers handed on (never `Set-Cookie`, never anything that could carry a token). */
export interface GitApiHeaders {
  readonly etag?: string;
  /** Pagination: `<https://api.github.com/…?page=2>; rel="next", …`. */
  readonly link?: string;
  readonly rateLimitRemaining?: string;
  readonly rateLimitReset?: string;
  /** The scopes the token really carries (`X-OAuth-Scopes`). */
  readonly oauthScopes?: string;
}
export interface GitApiAnswer {
  readonly status: number;
  /** The provider's JSON; `undefined` for a 304 or a 204. */
  readonly body: unknown;
  readonly headers: GitApiHeaders;
}

/** One `gh` run with an account's token in the child's environment. The token is never an argument or an answer. */
export interface GitRunSpec {
  /** The program; `gh` only (the declared spawn). */
  readonly program: 'gh';
  readonly args: readonly string[];
  /** Milliseconds; default 60 s, at most 5 min. */
  readonly timeoutMs?: number;
}
export interface GitRunResult {
  readonly exitCode: number | null;
  /** Both streams, with every occurrence of the token replaced by `[redacted]`. */
  readonly stdout: string;
  readonly stderr: string;
}

/** What other plugins may ask. There is no method that returns a token, and adding one would delete the feature. */
export interface GitAccountsApi {
  list(): Promise<readonly GitAccount[]>;
  /** The provider's API on an account's behalf, over a fixed set of paths. */
  api(account: GitAccountId, call: GitApiCall): Promise<GitApiAnswer>;
  /**
   * Runs `gh` as the account: the daemon puts the token in THAT child's environment (`GH_TOKEN`), sealed from the
   * host's own variables, and returns the child's scrubbed output. The use-never-read seam: there is no getter.
   */
  run(account: GitAccountId, spec: GitRunSpec): Promise<GitRunResult>;
  /** Records the public halves of the keys registered for an account (so removing the account deletes them too). */
  recordKeys(account: GitAccountId, keys: GitAccountKeys): Promise<void>;
}
export const GitAccountsPort = definePort<GitAccountsApi>('git-accounts');

/**
 * What `api()` forwards, by method. REST reads and writes on `api.github.com` and the one GraphQL endpoint; a `DELETE`
 * only for the two kinds of registered key (so no plugin can delete a repository or a branch through here). Whoever
 * holds the seam acts with `repo` scope, so only a daemon half that needs it should `use` this plugin.
 */
const REST = /^\/(?!graphql(?:\/|$))[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u;
export const GITHUB_API_RULES = {
  GET: [REST],
  POST: [REST, /^\/graphql$/u],
  PATCH: [REST],
  DELETE: [/^\/user\/keys\/[0-9]{1,20}$/u, /^\/user\/ssh_signing_keys\/[0-9]{1,20}$/u],
} as const satisfies Record<GitApiCall['method'], readonly RegExp[]>;

/** A plain query string after the path: plain characters only, bounded. */
export const GITHUB_API_QUERY = /^\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{1,1024}$/u;
