import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import type { LocalOutcome, OutboundTransport } from '../../daemon/adapters/provider-probe/bounded-transport.ts';

export interface AuthorizerCall {
  readonly secretName: string;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement?: CredentialPlacement;
}

/** The Vault's `authorizeFetch`, answered from a script. It never holds a value, as the real one never returns one. */
export class ScriptedAuthorizer {
  readonly calls: AuthorizerCall[] = [];

  constructor(private readonly outcome: AuthorizedOutcome) {}

  async authorizeFetch(
    secretName: string,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.calls.push({ secretName, hosts, request, ...(placement === undefined ? {} : { placement }) });
    return this.outcome;
  }
}

/** A transport that records every request it was handed. */
export class RecordingTransport implements OutboundTransport {
  readonly sent: OutboundHttpRequest[] = [];

  constructor(private readonly outcome: LocalOutcome = { kind: 'completion', payload: { ok: true } }) {}

  async send(request: OutboundHttpRequest): Promise<LocalOutcome> {
    this.sent.push(request);
    return this.outcome;
  }
}
