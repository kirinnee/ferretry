/**
 * The only network this plugin uses: the kernel's fetch port to `github.com` and `api.github.com`, bounded, never
 * following a redirect, and never logging. A request can carry a token or a device code, so a failure is a short code
 * for its KIND (a timeout, a DNS name error), never the address, the message or the body.
 */
import type { FetchPort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES, type GitApiHeaders } from '../../contract/index.ts';
import type { GithubHttp, GithubRequest, GithubResponse } from '../lib/github-http.ts';

const TIMEOUT_MS = 15_000;
/** A page of pull requests or check runs can be a few hundred kilobytes; the device flow's answers are tiny. */
const MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'ferretry-git-accounts';

/**
 * The only places a request may go: the two device-flow endpoints, and `api.github.com` (REST and `/graphql`). The device
 * flow's addresses never take a query; an API address may (pagination), made of plain characters only.
 */
const ALLOWED = [
  { host: 'github.com', path: /^\/login\/(device\/code|oauth\/access_token)$/u, query: false },
  { host: 'api.github.com', path: /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u, query: true },
] as const;
const SAFE_QUERY = /^\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,1024}$/u;

function transportReason(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'TIMEOUT';
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(code) ? code : 'UNKNOWN';
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new ApiError(502, 'GitHub answered with too much data', GIT_ACCOUNT_CODES.providerUnreachable);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

/** The few response headers the seam hands on; each is metadata about the call, none can carry a token. */
function headersOf(response: Response): GitApiHeaders {
  const pick = (name: string): string | undefined => {
    const value = response.headers.get(name);
    return value === null || value.length > 2048 ? undefined : value;
  };
  const etag = pick('etag');
  const link = pick('link');
  const remaining = pick('x-ratelimit-remaining');
  const reset = pick('x-ratelimit-reset');
  const scopes = pick('x-oauth-scopes');
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(link === undefined ? {} : { link }),
    ...(remaining === undefined ? {} : { rateLimitRemaining: remaining }),
    ...(reset === undefined ? {} : { rateLimitReset: reset }),
    ...(scopes === undefined ? {} : { oauthScopes: scopes }),
  };
}

export class FetchGithubHttp implements GithubHttp {
  constructor(private readonly network: FetchPort) {}

  async request(request: GithubRequest): Promise<GithubResponse> {
    const url = new URL(request.url);
    const rule = ALLOWED.find(
      each => url.protocol === 'https:' && url.host === each.host && each.path.test(url.pathname),
    );
    const plainPath = !url.pathname.includes('..') && !url.pathname.includes('//');
    const queryOk = url.search === '' || (rule?.query === true && SAFE_QUERY.test(url.search));
    if (rule === undefined || !plainPath || !queryOk)
      throw new TypeError('git-accounts: a request outside the GitHub allow-list');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`;
    if (request.ifNoneMatch !== undefined) headers['if-none-match'] = request.ifNoneMatch;
    let body: string | undefined;
    if (request.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form).toString();
    } else if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.json);
    }
    let response: Response;
    try {
      response = await this.network.request(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError(
        502,
        `GitHub could not be reached (${transportReason(error)})`,
        GIT_ACCOUNT_CODES.providerUnreachable,
      );
    }
    const text = await boundedText(response);
    let parsed: unknown;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, headers: headersOf(response) };
  }
}
