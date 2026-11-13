/** The outbound-call seam the Jev guard sends through (today's `speedups/ports.ts`; the Vault's `authorizedSend` fills it). */
interface OutboundHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

type OutboundOutcome =
  | { readonly kind: 'completion'; readonly payload: unknown }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly cause?: unknown };

interface CredentialPlacement {
  readonly header: string;
  readonly scheme?: string;
}

export type AuthorizedOutcome =
  | OutboundOutcome
  | { readonly kind: 'secret_missing' }
  | { readonly kind: 'vault_damaged' }
  | { readonly kind: 'refused' };

export interface OutboundAuthorizerPort {
  send(
    secretName: string,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome>;
}
