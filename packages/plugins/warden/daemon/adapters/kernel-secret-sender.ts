import { allowedDestination, type OutboundSecretOutcome, type SecretsPort } from '@ferretry/kernel/contract';
import type { AuthorizedOutcome, OutboundAuthorizerPort } from '../lib/jev-ports.ts';

/**
 * The Jev guard's outbound seam over `kernel.secrets.send` (K-secrets, design #9): the KERNEL places `JEV_API_KEY` on
 * the request, so the Warden never holds it. The kernel's rule decides first — the name is in the manifest's
 * `secrets`, `warden.yaml` names it as `jev.key: ${secret:JEV_API_KEY}` (only the owner may add that line: an agent's
 * write that adds it is held), the Vault knows it, and the URL is `https:` to a host the manifest's `network` names
 * exactly. This adapter only narrows: a URL outside the guard's own host list is refused before the kernel is asked.
 *
 * Every refusal of the NAME (`not_declared`, `not_configured`, `unknown`) is today's `secret_missing`, which the guard
 * answers `not_set`: no key, nothing leaves the machine, nothing is spent.
 */
export function kernelSecretSender(secrets: SecretsPort): OutboundAuthorizerPort {
  const port: OutboundAuthorizerPort = {
    send: async (secretName, hostAllowlist, request, placement) => {
      if (!allowedDestination(request.url, [...hostAllowlist].map(String))) return { kind: 'refused' };
      return authorizedOutcomeOf(await secrets.send(secretName, request, placement));
    },
  };
  return Object.freeze(port);
}

/** The kernel's outcome, in the words the guard reads (today's `AuthorizedOutcome`). */
export function authorizedOutcomeOf(outcome: OutboundSecretOutcome): AuthorizedOutcome {
  switch (outcome.kind) {
    case 'completion':
      return { kind: 'completion', payload: outcome.payload };
    case 'status':
      return outcome.retryAfterSeconds === undefined
        ? { kind: 'status', status: outcome.status }
        : { kind: 'status', status: outcome.status, retryAfterSeconds: outcome.retryAfterSeconds };
    case 'timeout':
      return { kind: 'timeout' };
    case 'network':
      return { kind: 'unreachable' };
    case 'too_large':
      return { kind: 'oversized' };
    case 'unreadable':
      return { kind: 'unreadable' };
    case 'vault_damaged':
      return { kind: 'vault_damaged' };
    case 'refused':
      return outcome.refused === 'destination' || outcome.refused === 'placement'
        ? { kind: 'refused' }
        : { kind: 'secret_missing' };
  }
}
