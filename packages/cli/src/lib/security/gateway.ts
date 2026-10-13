import {
  type SecuritySettingsChange,
  SecuritySettingsChangeSchema,
  type SecuritySettingsPatch,
  SecuritySettingsPatchSchema,
  type SecuritySettingsView,
  SecuritySettingsViewSchema,
} from '@ferretry/protocol';
import type { ISecurityGateway, SecurityApiClient } from './ports.ts';

export const SECURITY_PATH = '/v1/security';

/** Speaks the security routes through the protocol client, parsing both directions rather than casting. */
export class ProtocolSecurityGateway implements ISecurityGateway {
  constructor(private readonly client: SecurityApiClient) {}

  async read(): Promise<SecuritySettingsView> {
    return await this.client.request(SECURITY_PATH, SecuritySettingsViewSchema);
  }

  async change(patch: SecuritySettingsPatch): Promise<SecuritySettingsChange> {
    return await this.client.request(SECURITY_PATH, SecuritySettingsChangeSchema, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SecuritySettingsPatchSchema.parse(patch)),
    });
  }
}
