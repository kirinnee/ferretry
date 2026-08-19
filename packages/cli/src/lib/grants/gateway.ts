import {
  type GrantAuditView,
  GrantAuditViewSchema,
  GrantPasswordRequestSchema,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantsViewSchema,
  GrantUnlockRequestSchema,
  GrantUnlockViewSchema,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { GrantApiClient, IGrantGateway } from './ports.ts';

export const GRANTS_PATH = '/v1/grants';

const PasswordOutcomeSchema = GrantsViewSchema.pick({ passwordSet: true });

/**
 * Speaks the grant routes through the protocol client.
 *
 * Both directions are parsed rather than cast, for the reason every other gateway here is: a daemon
 * that answered an error envelope or an older shape would otherwise surface as an undefined field
 * deep inside rendering instead of as a stated failure.
 *
 * THE UNLOCK TRAVELS IN A HEADER AND IS NEVER RETAINED. It is passed to one call and forgotten; this
 * class holds no field for it, so there is nowhere for it to outlive the command that earned it.
 */
export class ProtocolGrantGateway implements IGrantGateway {
  constructor(private readonly client: GrantApiClient) {}

  async read(): Promise<GrantsView> {
    return await this.client.request(GRANTS_PATH, GrantsViewSchema);
  }

  async history(): Promise<GrantAuditView> {
    return await this.client.request(`${GRANTS_PATH}/audit`, GrantAuditViewSchema);
  }

  async change(patch: GrantsPatch, unlock?: string): Promise<GrantsView> {
    return await this.client.request(GRANTS_PATH, GrantsViewSchema, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock }),
      },
      body: JSON.stringify(GrantsPatchSchema.parse(patch)),
    });
  }

  async unlock(password: string): Promise<string> {
    const minted = await this.client.request(`${GRANTS_PATH}/unlock`, GrantUnlockViewSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(GrantUnlockRequestSchema.parse({ password })),
    });
    return minted.token;
  }

  async setPassword(password: string): Promise<boolean> {
    const outcome = await this.client.request(`${GRANTS_PATH}/password`, PasswordOutcomeSchema, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(GrantPasswordRequestSchema.parse({ password })),
    });
    return outcome.passwordSet;
  }
}
