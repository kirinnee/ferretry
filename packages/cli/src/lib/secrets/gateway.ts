import {
  PutSecretRequestSchema,
  RemovedSecretSchema,
  SecretListSchema,
  SecretSummarySchema,
  SecretUseRequestSchema,
  SecretUseResultSchema,
  type SecretList,
  type SecretSummary,
  type SecretUseRequest,
  type SecretUseResult,
} from '@ferretry/protocol';
import type { ISecretGateway, SecretApiClient } from './ports.ts';

/** The daemon's secret surface. Four paths, and none of them reads a value back. */
export const SECRETS_PATH = '/v1/secrets';

/**
 * Speaks the secret routes through the protocol client.
 *
 * Both directions are parsed rather than cast, for the reason every other gateway here is: a daemon
 * that answered an error envelope or an older shape would otherwise surface as an undefined field
 * deep inside rendering instead of as a stated failure.
 */
export class ProtocolSecretGateway implements ISecretGateway {
  constructor(private readonly client: SecretApiClient) {}

  async list(): Promise<SecretList> {
    return await this.client.request(SECRETS_PATH, SecretListSchema);
  }

  async put(name: string, value: string): Promise<SecretSummary> {
    return await this.client.request(SECRETS_PATH, SecretSummarySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PutSecretRequestSchema.parse({ name, value })),
    });
  }

  async remove(name: string): Promise<void> {
    await this.client.request(`${SECRETS_PATH}/${encodeURIComponent(name)}`, RemovedSecretSchema, { method: 'DELETE' });
  }

  async use(request: SecretUseRequest): Promise<SecretUseResult> {
    return await this.client.request(`${SECRETS_PATH}/use`, SecretUseResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SecretUseRequestSchema.parse(request)),
    });
  }
}
