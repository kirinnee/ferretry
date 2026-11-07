/**
 * The shapes of one authorised outbound call, copied structurally from the Vault port (`VaultApi.authorizeFetch`) so
 * Jev can be asked without Packs ever holding the key: the Vault places ONE named secret on ONE request to an
 * allowlisted host and answers only what came back.
 */

/** One outbound HTTP call, fully described so the transport decides nothing. */
export interface OutboundHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** Request headers WITHOUT any credential. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** Hard ceiling on the reply the transport may buffer before giving up. */
  readonly maxResponseBytes: number;
}

export type OutboundOutcome =
  | { readonly kind: 'completion'; readonly payload: unknown }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly cause?: unknown };

export type AuthorizedOutcome =
  | OutboundOutcome
  | { readonly kind: 'secret_missing' }
  | { readonly kind: 'vault_damaged' }
  | { readonly kind: 'refused' };

/** Asks the Vault to send one request with one named secret on it. */
export type Authorize = (
  secretName: string,
  hostAllowlist: readonly string[],
  request: OutboundHttpRequest,
) => Promise<AuthorizedOutcome>;
