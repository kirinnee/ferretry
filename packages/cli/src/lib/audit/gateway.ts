import { type AuditView, AuditViewSchema } from '@ferretry/protocol';
import type { AuditApiClient, IAuditGateway } from './ports.ts';

export const AUDIT_PATH = '/v1/audit';

/** Reads the security log through the protocol client, parsing the answer rather than casting it. */
export class ProtocolAuditGateway implements IAuditGateway {
  constructor(private readonly client: AuditApiClient) {}

  async read(limit: number, keptOffset = 0): Promise<AuditView> {
    const skip = keptOffset === 0 ? '' : `&keptOffset=${String(keptOffset)}`;
    return await this.client.request(`${AUDIT_PATH}?limit=${String(limit)}${skip}`, AuditViewSchema);
  }
}
