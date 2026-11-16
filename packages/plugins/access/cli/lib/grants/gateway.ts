import {
  type GrantAuditView,
  GrantAuditViewSchema,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantsViewSchema,
} from '../../../contract/index.ts';
import { callDaemon } from '../../shell.ts';
import type { GrantApiClient, IGrantGateway } from './ports.ts';

export const GRANTS_PATH = '/v1/grants';

/**
 * The route keys this gateway calls. The daemon-wide grants are Gate's (§4.13, §9.2): no manifest declares these
 * keys yet, so the shell's client refuses them until Gate's does.
 */
export const GRANT_ROUTES = {
  read: 'GET /v1/grants',
  history: 'GET /v1/grants/audit',
  change: 'PATCH /v1/grants',
} as const;

/**
 * Speaks the grant routes through the plugin client.
 *
 * Both directions are parsed rather than cast, for the reason every other gateway here is: a daemon
 * that answered an error envelope or another shape would otherwise surface as an undefined field
 * deep inside rendering instead of as a stated failure.
 */
export class ProtocolGrantGateway implements IGrantGateway {
  constructor(private readonly client: GrantApiClient) {}

  async read(): Promise<GrantsView> {
    return GrantsViewSchema.parse(await callDaemon(this.client, GRANT_ROUTES.read));
  }

  async history(): Promise<GrantAuditView> {
    return GrantAuditViewSchema.parse(await callDaemon(this.client, GRANT_ROUTES.history));
  }

  async change(patch: GrantsPatch): Promise<GrantsView> {
    return GrantsViewSchema.parse(
      await callDaemon(this.client, GRANT_ROUTES.change, { body: GrantsPatchSchema.parse(patch) }),
    );
  }
}
