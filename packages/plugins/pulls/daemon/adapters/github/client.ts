import { ApiError, type Log } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import type { GitAccountId, GitAccountsApi, GitApiAnswer } from '@ferretry/plugin-git-accounts/contract';
import { GithubBodySchema, PULLS_CODES, type PullsCode, type RateResource } from '../../../contract/index.ts';
import type { PullsCache } from '../../lib/cache/store.ts';
import { RateBudget } from './budget.ts';
import { nextPagePath } from './link.ts';

/** What a read says when it did not answer. `message` is ours, never GitHub's text. */
export interface ReadFailure {
  readonly code: PullsCode;
  readonly status?: number;
  readonly message: string;
  /** Set for `paused`: the instant (ms) polling resumes. */
  readonly pausedUntilMs?: number;
}

export interface ReadAnswer {
  readonly body: unknown;
  /** `true` when GitHub answered `304` and this is the cached body. */
  readonly fromCache: boolean;
  readonly etag?: string;
  /** The `Link` header (from the answer, or the cached one on a `304`). */
  readonly link?: string;
}

export interface PagedAnswer {
  readonly items: readonly unknown[];
  /** Every page came from the cache (all `304`). */
  readonly fromCache: boolean;
  /** Stopped at `maxPages` with more pages still linked. */
  readonly truncated: boolean;
}

/**
 * What a write came to. `unsent`: it certainly did not leave. `answered`: GitHub said a status (`paused` is set when that
 * answer used up the allowance). `unknown`: it may have reached GitHub and no usable answer came back.
 */
export type WriteOutcome =
  | { readonly kind: 'unsent'; readonly failure: ReadFailure }
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly body: unknown;
      readonly paused: ReadFailure | undefined;
    }
  | { readonly kind: 'unknown' };

export interface Reading {
  /** Whose cache the answer is kept in. */
  readonly project: string;
  readonly account: GitAccountId;
  /** An API path such as `/repos/o/r/pulls?state=open&per_page=100`. */
  readonly path: string;
}

const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES = 40;

/** Whether GitHub's own message says a rate or abuse limit was hit (the text is read here and never passed on). */
function saysLimited(body: unknown): boolean {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' && /rate limit|abuse/iu.test(message);
}

/**
 * GitHub REST and GraphQL over `git-accounts`' api seam. This class never holds a token: it names an account and the
 * seam places the token on the request. A REST `GET` is conditional (`If-None-Match`) and answered from the cache on a
 * `304`, which costs no rate limit; `Link` pages are followed; the rate budget pauses everything below 10 %.
 */
export class GithubClient {
  readonly budget: RateBudget;

  constructor(
    private readonly accounts: Pick<GitAccountsApi, 'api'>,
    private readonly cache: PullsCache,
    nowMs: () => number,
    private readonly log: Log,
  ) {
    this.budget = new RateBudget(nowMs);
  }

  /** A conditional REST `GET`. */
  async get(reading: Reading): Promise<Result<ReadAnswer, ReadFailure>> {
    const paused = this.#paused(reading.account, 'rest');
    if (paused !== undefined) return err(paused);
    // Taken before GitHub is asked: a purge that lands while the call is out makes this read's write a no-op.
    const stamp = this.cache.stamp(reading.project, reading.account);
    const cached = await this.cache.get(reading.project, reading.account, reading.path);
    const first = await this.#call(reading.account, 'rest', {
      method: 'GET',
      path: reading.path,
      ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
    });
    if (!first.ok) return first;
    const answer = first.value;
    if (answer.status === 304) {
      // A validator is only ever sent with a cached entry, so a 304 with none is a provider that answered wrongly.
      if (cached === undefined)
        return err({ code: PULLS_CODES.github, status: 304, message: 'GitHub answered with an error' });
      return ok({
        body: cached.body,
        fromCache: true,
        etag: cached.etag,
        ...(cached.link === undefined ? {} : { link: cached.link }),
      });
    }
    if (answer.status !== 200) return err(this.#failure(reading.account, 'rest', answer.status));
    // The seam turns text it cannot parse into `null`; a 200 with no usable body is not an answer and is never kept.
    const body = GithubBodySchema.safeParse(answer.body);
    if (!body.success) return err({ code: PULLS_CODES.github, status: 200, message: 'GitHub answered with an error' });
    const etag = answer.headers.etag;
    const link = answer.headers.link;
    if (etag !== undefined)
      await this.cache.put(reading.project, reading.account, reading.path, { etag, link, body: body.data }, stamp);
    return ok({
      body: body.data,
      fromCache: false,
      ...(etag === undefined ? {} : { etag }),
      ...(link === undefined ? {} : { link }),
    });
  }

  /** Every page of a list, following `Link: rel="next"` up to `maxPages` (default 10, at most 40). */
  async getAll(reading: Reading, maxPages = DEFAULT_MAX_PAGES): Promise<Result<PagedAnswer, ReadFailure>> {
    const limit = Math.min(Math.max(1, Math.floor(maxPages)), MAX_PAGES);
    const items: unknown[] = [];
    let path: string | undefined = reading.path;
    let allCached = true;
    for (let page = 0; page < limit && path !== undefined; page += 1) {
      const read: Result<ReadAnswer, ReadFailure> = await this.get({ ...reading, path });
      if (!read.ok) return read;
      if (!Array.isArray(read.value.body))
        return err({ code: PULLS_CODES.github, message: 'GitHub answered something other than a list' });
      items.push(...(read.value.body as unknown[]));
      allCached &&= read.value.fromCache;
      path = nextPagePath(read.value.link);
    }
    return ok({ items, fromCache: allCached, truncated: path !== undefined });
  }

  /**
   * A GraphQL query. GraphQL has no ETag, so nothing is cached: the caller reads it when a PR page opens or when the
   * REST side saw the PR change. A `200` with `errors` is a failure; GitHub's message is not passed on.
   */
  async graphql(
    account: GitAccountId,
    query: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<Result<unknown, ReadFailure>> {
    const paused = this.#paused(account, 'graphql');
    if (paused !== undefined) return err(paused);
    const call = await this.#call(account, 'graphql', { method: 'POST', path: '/graphql', body: { query, variables } });
    if (!call.ok) return call;
    if (call.value.status !== 200) return err(this.#failure(account, 'graphql', call.value.status));
    const body = call.value.body as { data?: unknown; errors?: unknown } | undefined;
    if (
      body === undefined ||
      body === null ||
      typeof body !== 'object' ||
      (Array.isArray(body.errors) && body.errors.length > 0) ||
      body.data === undefined
    )
      return err({ code: PULLS_CODES.github, message: 'GitHub could not answer that query' });
    return ok(body.data);
  }

  /**
   * A WRITE (a comment): one `POST`, never cached and NEVER retried, here or by any caller. It does not say "failed" when
   * it cannot know: a call that may have reached GitHub and got no answer is `unknown`, and only `unsent` is certain.
   * GitHub's text is read for nothing and passed on to nobody; a status is all a caller gets.
   */
  async write(
    account: GitAccountId,
    resource: RateResource,
    call: { readonly path: string; readonly body: unknown },
  ): Promise<WriteOutcome> {
    const paused = this.#paused(account, resource);
    if (paused !== undefined) return { kind: 'unsent', failure: paused };
    let answer: GitApiAnswer;
    try {
      answer = await this.accounts.api(account, { method: 'POST', path: call.path, body: call.body });
    } catch (error) {
      // The seam refuses before it sends (a path it does not allow, a body too large, an account that is gone). A
      // transport failure or timeout (a 502 from it) can come AFTER the request left, so that one stays unknown.
      const sure = error instanceof TypeError || (error instanceof ApiError && error.status !== 502);
      this.log.warn('a GitHub write did not answer', { reason: error instanceof Error ? error.name : 'error' });
      return sure
        ? { kind: 'unsent', failure: { code: PULLS_CODES.refused, message: 'that GitHub call could not be made' } }
        : { kind: 'unknown' };
    }
    this.budget.observe(account, resource, answer.headers, answer.status, saysLimited(answer.body));
    // A server error may have been acted on before it failed: it is not "did not post".
    if (answer.status >= 500) return { kind: 'unknown' };
    return { kind: 'answered', status: answer.status, body: answer.body, paused: this.#paused(account, resource) };
  }

  #paused(account: GitAccountId, resource: RateResource): ReadFailure | undefined {
    const until = this.budget.pausedUntil(account, resource);
    return until === undefined
      ? undefined
      : { code: PULLS_CODES.paused, message: 'paused to stay inside the rate limit', pausedUntilMs: until };
  }

  async #call(
    account: GitAccountId,
    resource: RateResource,
    call: Parameters<GitAccountsApi['api']>[1],
  ): Promise<Result<GitApiAnswer, ReadFailure>> {
    let answer: GitApiAnswer;
    try {
      answer = await this.accounts.api(account, call);
    } catch (error) {
      // The seam refuses a path it does not allow, an account that is gone, and a network that fails. The text is not passed on.
      this.log.warn('a GitHub call failed', { reason: error instanceof Error ? error.name : 'error' });
      return err({ code: PULLS_CODES.refused, message: 'that GitHub call could not be made' });
    }
    this.budget.observe(account, resource, answer.headers, answer.status, saysLimited(answer.body));
    return ok(answer);
  }

  /** A status that is not an answer. A 403 or 429 that used up the allowance reads as `paused`, not as "denied". */
  #failure(account: GitAccountId, resource: RateResource, status: number): ReadFailure {
    const paused = this.#paused(account, resource);
    if (paused !== undefined) return paused;
    if (status === 404)
      return {
        code: PULLS_CODES.notFound,
        status,
        message: 'GitHub does not have that, or this account cannot see it',
      };
    if (status === 401 || status === 403 || status === 429)
      return { code: PULLS_CODES.denied, status, message: 'GitHub refused that request' };
    return { code: PULLS_CODES.github, status, message: 'GitHub answered with an error' };
  }
}
