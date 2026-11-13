import type {
  AuthorizedOutcome,
  CredentialPlacement,
  OutboundHttpRequest,
  SecretName,
  VaultApi,
} from '@ferretry/core-vault/contract';
import type { OutboundAuthorizerPort } from '../lib/stt/ports.ts';

/**
 * THE ONE HOLDER Voice spends a speed-up key through (S162). It is the Vault's, not a second copy: `authorizeFetch`
 * puts ONE named secret on ONE outbound HTTPS request to a host that secret is allowed to reach, refuses a request that
 * already carries the credential header, reports a reply that echoes the key as unreadable, and says `vault_damaged`
 * rather than "no key" for a store it cannot open (S163–S166). Voice names the secret and the hosts and receives only
 * what came back; it is never handed a value.
 */
export class OutboundProviderAuthorizer implements OutboundAuthorizerPort {
  constructor(private readonly vault: Pick<VaultApi, 'authorizeFetch'>) {}

  async send(
    secretName: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    return await this.vault.authorizeFetch(secretName, hostAllowlist, request, placement);
  }
}
