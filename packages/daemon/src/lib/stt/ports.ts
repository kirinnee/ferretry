import type { OutboundAuthorizerPort, OutboundHttpRequest, OutboundOutcome } from '../speedups/ports.ts';

/**
 * The enhancer's boundaries.
 *
 * IT NEVER HOLDS A CREDENTIAL. The provider key is spent by the daemon's outbound holder
 * (`speedups/authorizer.ts`), which reads it from the secret store, puts it on the request to an
 * allowlisted host and hands back only the reply. The enhancer names the secret; it never sees it.
 */

/** One outbound chat-completion call, fully described so the transport decides nothing. */
export type EnhancementHttpRequest = OutboundHttpRequest;

/** What the transport observed, before the enhancer decides what it means. */
export type EnhancementOutcome = OutboundOutcome;

/** The authenticated call the enhancer makes — the outbound holder, or a fake in a test. */
export type EnhancementAuthorizer = OutboundAuthorizerPort;

/** Monotonic milliseconds, used for latency only — never for wall-clock stamps. */
export interface SttMonotonicClockPort {
  monotonicMs(): number;
}
