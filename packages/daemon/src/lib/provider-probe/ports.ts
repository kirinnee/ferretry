import type { AuthorizedOutcome } from '../speedups/ports.ts';
import type { ProviderProbePlan } from './plan.ts';

/**
 * The one boundary a login Test crosses (docs/provider-presets.md).
 *
 * The adapter sends an `authorized` plan through the outbound holder (`OutboundProviderAuthorizer`,
 * the fifth vault holder in docs/secrets.md), which puts the named secret on that one request and hands
 * back only what came back; a `local` plan carries no key and reads a server on this machine. Either
 * way the answer is facts — a status, a parsed reply, a refusal — never the request it built.
 */
export interface ProviderProbePort {
  probe(plan: ProviderProbePlan): Promise<AuthorizedOutcome>;
}

/** The secret names the store holds. `SecretDirectory.list()` satisfies it; names only, never values. */
export interface ProviderSecretNames {
  list(): Promise<readonly { readonly name: string }[]>;
}

/** Monotonic milliseconds for latency, and the wall-clock instant a result is stamped with. */
export interface ProviderProbeClock {
  monotonicMs(): number;
  now(): string;
}
