import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest, SecretName } from '@ferretry/core-vault/contract';

/**
 * The enhancer's boundaries.
 *
 * IT NEVER HOLDS A CREDENTIAL. The provider key is spent by the Vault's outbound holder (`authorizeFetch`), which reads
 * it from the sealed store, puts it on the request to an allowlisted host and hands back only the reply. The enhancer
 * names the secret; it never sees it.
 */

/** One outbound chat-completion call, fully described so the transport decides nothing. */
export type EnhancementHttpRequest = OutboundHttpRequest;

/** What the transport observed, before the enhancer decides what it means. */
export type EnhancementOutcome = AuthorizedOutcome;

/** The authenticated call the enhancer makes — the Vault's outbound holder, or a fake in a test. */
export interface OutboundAuthorizerPort {
  send(
    secretName: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome>;
}
export type EnhancementAuthorizer = OutboundAuthorizerPort;

/** Monotonic milliseconds, used for latency only — never for wall-clock stamps. */
export interface SttMonotonicClockPort {
  monotonicMs(): number;
}
