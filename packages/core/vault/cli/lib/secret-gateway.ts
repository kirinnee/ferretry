import type { PluginClient } from '@ferretry/kernel/manifest';
import { PutSecretBodySchema, type SecretSummary, SecretSummarySchema } from '../../contract/index.ts';
import type { SecretPutGateway } from './secret-controller.ts';

/** The only client capability the gateway consumes. */
export type SecretApiClient = Pick<PluginClient, 'call'>;

/** The manifest's route key for storing or replacing a secret. */
const PUT_SECRET_ROUTE = 'POST /v1/secrets';

/**
 * Speaks the one secret route `fy secret set` needs, through the plugin client. Both directions are parsed rather than
 * cast; the answer is a name and two instants and never a value.
 */
export class RouteSecretGateway implements SecretPutGateway {
  constructor(private readonly client: SecretApiClient) {}

  async put(name: string, value: string): Promise<SecretSummary> {
    return SecretSummarySchema.parse(
      await this.client.call(PUT_SECRET_ROUTE, { body: PutSecretBodySchema.parse({ name, value }) }),
    );
  }
}
