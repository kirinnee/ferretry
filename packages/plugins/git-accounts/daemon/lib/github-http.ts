/** The seam to GitHub's HTTP: what the device flow and the account service ask, never how it is carried. */
import type { GitApiHeaders } from '../../contract/index.ts';

export interface GithubRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  /** `Authorization` is set from `bearer`; nothing else secret goes in a header. */
  readonly bearer?: string;
  /** A conditional request: sent as `If-None-Match`. */
  readonly ifNoneMatch?: string;
  /** Sent as `application/x-www-form-urlencoded` when `form`, as JSON when `json`. */
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}
export interface GithubResponse {
  readonly status: number;
  /** Parsed body; `undefined` for an empty one (a 304, a 204), `null` when the text was not JSON. */
  readonly body: unknown;
  readonly headers: GitApiHeaders;
}
export interface GithubHttp {
  request(request: GithubRequest): Promise<GithubResponse>;
}
