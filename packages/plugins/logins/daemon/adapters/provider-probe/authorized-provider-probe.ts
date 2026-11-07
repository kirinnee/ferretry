import type { AuthorizedOutcome, VaultApi } from '@ferretry/core-vault/contract';
import { isLoopbackHost } from '../../lib/shared/address.ts';
import type { ProviderProbePlan } from '../../lib/provider-probe/plan.ts';
import type { ProviderProbePort } from '../../lib/provider-probe/ports.ts';
import type { OutboundTransport } from './bounded-transport.ts';

/**
 * Sends a login Test (docs/provider-presets.md).
 *
 * A plan with a key goes through the Vault's `authorizeFetch` — which puts the named secret on that one request to
 * that one host and returns only what came back (docs/secrets.md). This adapter never holds a secret. A plan without
 * a key reads a server on this machine through the plain transport, and is refused here if its address is anywhere
 * else, whatever the plan says.
 */
export class AuthorizedProviderProbe implements ProviderProbePort {
  constructor(
    private readonly vault: Pick<VaultApi, 'authorizeFetch'>,
    private readonly transport: OutboundTransport,
  ) {}

  async probe(plan: ProviderProbePlan): Promise<AuthorizedOutcome> {
    if (plan.kind === 'authorized') {
      return await this.vault.authorizeFetch(plan.secretName, plan.hosts, plan.request, plan.placement);
    }
    const url = new URL(plan.request.url);
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return { kind: 'refused' };
    return await this.transport.send(plan.request);
  }
}
