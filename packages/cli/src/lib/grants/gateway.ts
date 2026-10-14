import {
  type GrantAuditView,
  GrantAuditViewSchema,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantsViewSchema,
} from '@ferretry/protocol';
import type { GrantApiClient, IGrantGateway } from './ports.ts';

export const GRANTS_PATH = '/v1/grants';

/**
 * Speaks the grant routes through the protocol client.
 *
 * Both directions are parsed rather than cast, for the reason every other gateway here is: a daemon
 * that answered an error envelope or an older shape would otherwise surface as an undefined field
 * deep inside rendering instead of as a stated failure.
 */
export class ProtocolGrantGateway implements IGrantGateway {
  constructor(private readonly client: GrantApiClient) {}

  async read(): Promise<GrantsView> {
    return await this.client.request(GRANTS_PATH, GrantsViewSchema);
  }

  async history(): Promise<GrantAuditView> {
    return await this.client.request(`${GRANTS_PATH}/audit`, GrantAuditViewSchema);
  }

  async change(patch: GrantsPatch): Promise<GrantsView> {
    return await this.client.request(GRANTS_PATH, GrantsViewSchema, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(GrantsPatchSchema.parse(patch)),
    });
  }
}
