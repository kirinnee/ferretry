import type { QueryParameters } from '../http.ts';

/** A security-path allow-list, not a general plugin control channel. */
export const DELEGATE_PLUGINS = ['connector'] as const;
export const CONNECTOR_GRANT_PATTERN = /^cg_[a-z2-7]{10}$/u;
export type RouteKey = `${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'} /${string}`;

export interface DelegateRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: QueryParameters;
  readonly body?: unknown;
  /** The only forwarded header: x-fy-request-id. */
  readonly requestId?: string;
}

/** Plain text after the route's final check and the host-credential literal mask. No late or binary escape hatch. */
export interface DelegateResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** An approved connector's authority, through the real route dispatcher and Gate on EVERY call. Never local. */
export interface DelegatePort {
  call(principal: { readonly grant: string }, request: DelegateRequest): Promise<DelegateResponse>;
}
