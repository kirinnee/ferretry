import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type AccountChange,
  type AccountChangeOutcome,
  AccountChangeOutcomeSchema,
  AccountChangeRequestSchema,
  type AccountChangeView,
  AccountChangeViewSchema,
  type ComponentCatalog,
  ComponentCatalogSchema,
  type LayeredProfileCatalog,
  LayeredProfileCatalogSchema,
  type MachineView,
  MachineViewSchema,
  ProposalApplyRequestSchema,
  type Recommendation,
  type RecommendationRequest,
  RecommendationRequestSchema,
  RecommendationSchema,
  type RuntimeCatalog,
  RuntimeCatalogSchema,
  type SetupScan,
  SetupScanSchema,
} from '../../../contract/index.ts';
import type { IRuntimesGateway } from './account-ports.ts';

/** The route keys the manifest declares (`/v1/runtimes/...`); a typo here is a missing route, not a 404 at run time. */
export const ROUTES = {
  machine: 'GET /v1/runtimes/machine',
  components: 'GET /v1/runtimes/components',
  profiles: 'GET /v1/runtimes/profiles',
  runtimes: 'GET /v1/runtimes',
  propose: 'POST /v1/runtimes/proposals',
  apply: 'POST /v1/runtimes/proposals/:proposalId/apply',
  scan: 'GET /v1/runtimes/setup/scan',
  recommend: 'POST /v1/runtimes/recommend',
} as const;

/**
 * Speaks the runtimes routes through the plugin client, parsing every answer through the shared schema,
 * which has no field a login could occupy.
 *
 * THIS CLASS HOLDS NO AUTHORITY. A write is not confirmed by anything the command line carries: the
 * daemon governs a caller by how it arrived, and a caller on this machine is ungoverned.
 *
 * GAP(kernel): `PluginClient.call` takes no timeout. Probing every login's quota for a recommendation is
 * slow (several provider round trips) and was given 60 seconds; the client's own patience applies now.
 */
export class ClientRuntimesGateway implements IRuntimesGateway {
  constructor(private readonly client: PluginClient) {}

  async machine(): Promise<MachineView> {
    return MachineViewSchema.parse(await this.client.call(ROUTES.machine));
  }

  async components(): Promise<ComponentCatalog> {
    return ComponentCatalogSchema.parse(await this.client.call(ROUTES.components));
  }

  async profiles(): Promise<LayeredProfileCatalog> {
    return LayeredProfileCatalogSchema.parse(await this.client.call(ROUTES.profiles));
  }

  async runtimes(): Promise<RuntimeCatalog> {
    return RuntimeCatalogSchema.parse(await this.client.call(ROUTES.runtimes));
  }

  async stage(change: AccountChange): Promise<AccountChangeView> {
    const body = AccountChangeRequestSchema.parse({ change });
    return AccountChangeViewSchema.parse(await this.client.call(ROUTES.propose, { body }));
  }

  async apply(changeId: string): Promise<AccountChangeOutcome> {
    const body = ProposalApplyRequestSchema.parse({});
    return AccountChangeOutcomeSchema.parse(
      await this.client.call(ROUTES.apply, { params: { proposalId: changeId }, body }),
    );
  }

  async scan(): Promise<SetupScan> {
    return SetupScanSchema.parse(await this.client.call(ROUTES.scan));
  }

  async recommend(request: RecommendationRequest): Promise<Recommendation> {
    const body = RecommendationRequestSchema.parse(request);
    return RecommendationSchema.parse(await this.client.call(ROUTES.recommend, { body }));
  }
}
