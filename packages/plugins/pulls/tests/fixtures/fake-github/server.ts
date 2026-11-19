/**
 * The base of the fake GitHub every E unit tests against (owned by E1; a later unit adds its own handlers in its own file
 * in this folder and registers them with `on()`). It answers what `api.github.com` answers for the parts the client
 * relies on: an `ETag` per resource, `304` for a matching `If-None-Match` (which costs no rate limit), `Link` paging,
 * and `X-RateLimit-*` headers. Fake data only, no network.
 *
 * It is reached through `accounts`, which stands in for `git-accounts`' api seam and enforces the SAME rules the real
 * one does (`GITHUB_API_RULES`, `GITHUB_API_QUERY`), so a path the real seam would refuse is refused here too. `fetch`
 * has the shape of the kernel's fetch for a test that wants to mount it behind the real `git-accounts` half.
 */
import {
  GITHUB_API_QUERY,
  GITHUB_API_RULES,
  type GitAccount,
  type GitAccountId,
  type GitAccountsApi,
  type GitApiCall,
} from '@ferretry/plugin-git-accounts/contract';

export const FAKE_ACCOUNT = 'gha_4242' as GitAccountId;

export interface FakeSeen {
  readonly method: string;
  readonly path: string;
  readonly ifNoneMatch?: string;
  readonly account: GitAccountId;
  readonly body?: unknown;
}

interface FakeReply {
  readonly status: number;
  readonly body?: unknown;
  /** The seam's header names: `etag`, `link`, `rateLimitRemaining`, `rateLimitReset`, `oauthScopes`. */
  readonly headers?: Readonly<Record<string, string>>;
}
/** A handler a unit registers for a method and a path (no query). `query` is the parsed query. */
export type FakeHandler = (request: { readonly query: URLSearchParams; readonly body: unknown }) => FakeReply;

interface Resource {
  /** The whole list (paged) or one object. */
  readonly value: unknown;
  readonly version: number;
  readonly perPage: number | undefined;
}

export class FakeGithub {
  readonly seen: FakeSeen[] = [];
  /** The hourly allowance and what is left. A `304` does not spend it. */
  limit = 5000;
  remaining = 5000;
  /** Unix seconds. */
  resetAtSec = 1_790_000_000;
  /** Accounts the fake knows. A call for any other account throws, as the real seam does. */
  readonly knownAccounts = new Set<GitAccountId>([FAKE_ACCOUNT]);
  readonly #resources = new Map<string, Resource>();
  readonly #handlers = new Map<string, FakeHandler>();
  readonly #failures = new Map<string, number>();
  #version = 0;

  /** Serves `value` at `path` (query keys other than `page` and `per_page` are part of the identity). */
  set(path: string, value: unknown): void {
    this.#resources.set(this.#key(path), { value, version: this.#bump(), perPage: undefined });
  }

  /** Serves a list at `path`, `perPage` to a page, with `Link: rel="next"` between pages. */
  setPaged(path: string, items: readonly unknown[], perPage: number): void {
    this.#resources.set(this.#key(path), { value: items, version: this.#bump(), perPage });
  }

  /** Registers a handler for a method and a path; it answers instead of the stored resources. */
  on(method: string, path: string, handler: FakeHandler): void {
    this.#handlers.set(`${method} ${path}`, handler);
  }

  /** Every call to `path` answers `status` with no body, until `clearFailure`. */
  fail(path: string, status: number): void {
    this.#failures.set(this.#key(path), status);
  }
  clearFailure(path: string): void {
    this.#failures.delete(this.#key(path));
  }

  /** What the next answers say is left. */
  rate(remaining: number, resetAtSec: number, limit = this.limit): void {
    this.remaining = remaining;
    this.resetAtSec = resetAtSec;
    this.limit = limit;
  }

  readonly account: GitAccount = {
    id: FAKE_ACCOUNT,
    provider: 'github',
    githubId: 4242,
    login: 'octo-fake',
    scopes: ['read:user', 'repo'],
    keys: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  /** Stands in for `GitAccountsApi` (the pieces E units use). */
  readonly accounts: Pick<GitAccountsApi, 'api' | 'list'> = {
    list: async () => [this.account],
    api: async (id, call) => await this.#api(id, call),
  };

  /** The kernel's fetch shape, for mounting behind the real git-accounts half. */
  readonly fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as unknown) : undefined;
    const answer = this.#answer(FAKE_ACCOUNT, {
      method: (init?.method ?? 'GET') as GitApiCall['method'],
      path: `${url.pathname}${url.search}`,
      ...(headers.get('if-none-match') === null ? {} : { ifNoneMatch: headers.get('if-none-match') as string }),
      ...(body === undefined ? {} : { body }),
    });
    const out = new Headers({ 'content-type': 'application/json' });
    // Back to GitHub's own header names, for a test that mounts this behind the real half.
    const wire: Record<string, string> = {
      etag: 'etag',
      link: 'link',
      rateLimitRemaining: 'x-ratelimit-remaining',
      rateLimitReset: 'x-ratelimit-reset',
      oauthScopes: 'x-oauth-scopes',
    };
    for (const [key, value] of Object.entries(answer.headers)) out.set(wire[key] ?? key, value);
    out.set('x-ratelimit-limit', String(this.limit));
    return new Response(answer.status === 304 || answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: out,
    });
  };

  async #api(id: GitAccountId, call: GitApiCall) {
    // The real seam's rules, from its own contract.
    const at = call.path.search(/[?#]/u);
    const path = at < 0 ? call.path : call.path.slice(0, at);
    const query = at < 0 ? '' : call.path.slice(at);
    const rules: readonly RegExp[] = GITHUB_API_RULES[call.method] ?? [];
    if (
      path.includes('..') ||
      path.includes('//') ||
      !rules.some(rule => rule.test(path)) ||
      (query !== '' && !GITHUB_API_QUERY.test(query))
    )
      throw new Error('that GitHub API call is not one Git accounts makes');
    if (!this.knownAccounts.has(id)) throw new Error('no such git account');
    return this.#answer(id, call);
  }

  #answer(id: GitAccountId, call: GitApiCall): { status: number; body: unknown; headers: Record<string, string> } {
    const url = new URL(call.path, 'https://api.github.com');
    this.seen.push({
      method: call.method,
      path: `${url.pathname}${url.search}`,
      account: id,
      ...(call.ifNoneMatch === undefined ? {} : { ifNoneMatch: call.ifNoneMatch }),
      ...(call.body === undefined ? {} : { body: call.body }),
    });
    const rate = (spent: boolean): Record<string, string> => {
      if (spent) this.remaining = Math.max(0, this.remaining - 1);
      // The seam's own names for the headers it hands on (`GitApiHeaders`): the limit is not one of them.
      return {
        rateLimitRemaining: String(this.remaining),
        rateLimitReset: String(this.resetAtSec),
        oauthScopes: 'read:user, repo',
      };
    };
    if (this.remaining === 0 && call.ifNoneMatch === undefined)
      return { status: 403, body: { message: 'API rate limit exceeded' }, headers: rate(false) };
    const failure = this.#failures.get(this.#key(`${url.pathname}${url.search}`));
    if (failure !== undefined) return { status: failure, body: { message: 'fake failure' }, headers: rate(true) };
    const handler = this.#handlers.get(`${call.method} ${url.pathname}`);
    if (handler !== undefined) {
      const reply = handler({ query: url.searchParams, body: call.body });
      return {
        status: reply.status,
        body: reply.body,
        headers: { ...rate(true), ...(reply.headers ?? {}) },
      };
    }
    const resource = this.#resources.get(this.#key(`${url.pathname}${url.search}`));
    if (call.method !== 'GET' || resource === undefined)
      return { status: 404, body: { message: 'Not Found' }, headers: rate(true) };

    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const etag = `W/"${resource.version}-${page}"`;
    if (call.ifNoneMatch === etag) return { status: 304, body: undefined, headers: { ...rate(false), etag } };

    const headers: Record<string, string> = { ...rate(true), etag };
    let body = resource.value;
    if (resource.perPage !== undefined && Array.isArray(resource.value)) {
      const from = (page - 1) * resource.perPage;
      body = resource.value.slice(from, from + resource.perPage);
      if (from + resource.perPage < resource.value.length) {
        const next = new URLSearchParams(url.searchParams);
        next.set('page', String(page + 1));
        headers.link = `<https://api.github.com${url.pathname}?${next.toString()}>; rel="next"`;
      }
    }
    return { status: 200, body, headers };
  }

  #bump(): number {
    this.#version += 1;
    return this.#version;
  }

  /** The identity of a resource: its path and its query minus paging. */
  #key(path: string): string {
    const url = new URL(path, 'https://api.github.com');
    const rest = new URLSearchParams(url.searchParams);
    rest.delete('page');
    rest.delete('per_page');
    rest.sort();
    return `${url.pathname}?${rest.toString()}`;
  }
}
