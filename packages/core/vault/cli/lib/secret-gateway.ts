import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  PutSecretBodySchema,
  RemovedSecretSchema,
  type SecretList,
  SecretListSchema,
  type SecretSummary,
  SecretSummarySchema,
  type SecretUseRequest,
  SecretUseRequestSchema,
  type SecretUseResult,
  SecretUseResultSchema,
} from '../../contract/index.ts';
import type { SecretGateway } from './secret-controller.ts';

/** The only client capability the gateway consumes. */
export type SecretApiClient = Pick<PluginClient, 'call'>;

/**
 * Speaks the secret routes `fy secret …` needs, through the plugin client. Both directions are parsed rather than
 * cast: a daemon that answered an error envelope or an older shape would otherwise surface as an undefined field deep
 * inside rendering instead of as a stated failure. NONE of the four answers carries a value.
 */
export class RouteSecretGateway implements SecretGateway {
  constructor(private readonly client: SecretApiClient) {}

  async list(): Promise<SecretList> {
    return SecretListSchema.parse(await this.client.call('GET /v1/secrets'));
  }

  async put(name: string, value: string): Promise<SecretSummary> {
    return SecretSummarySchema.parse(
      await this.client.call('POST /v1/secrets', { body: PutSecretBodySchema.parse({ name, value }) }),
    );
  }

  async remove(name: string): Promise<void> {
    RemovedSecretSchema.parse(await this.client.call('DELETE /v1/secrets/:name', { params: { name } }));
  }

  async use(request: SecretUseRequest): Promise<SecretUseResult> {
    return SecretUseResultSchema.parse(
      await this.client.call('POST /v1/secrets/use', { body: SecretUseRequestSchema.parse(request) }),
    );
  }
}
