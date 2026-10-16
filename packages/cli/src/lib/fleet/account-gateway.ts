import {
  FLEET_PRESETS_PATH,
  type FleetAccountChange,
  type FleetAccountChangeOutcome,
  FleetAccountChangeOutcomeSchema,
  FleetAccountChangeRequestSchema,
  type FleetAccountChangeView,
  FleetAccountChangeViewSchema,
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetComponentCatalog,
  FleetComponentCatalogSchema,
  FleetCredentialCheckRequestSchema,
  type FleetCredentialList,
  FleetCredentialListSchema,
  FleetCredentialTestRequestSchema,
  type FleetCredentialTestResult,
  FleetCredentialTestResultSchema,
  type FleetCredentialView,
  FleetCredentialViewSchema,
  type FleetLayeredProfileCatalog,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineView,
  FleetMachineViewSchema,
  FleetProposalApplyRequestSchema,
  type FleetProviderPresetCatalog,
  FleetProviderPresetCatalogSchema,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetSetupScan,
  FleetSetupScanSchema,
  FleetToolInstallRequestSchema,
  type FleetToolInstallResult,
  FleetToolInstallResultSchema,
  type HarnessLoginCodexMethod,
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
} from '@ferretry/protocol';
import type { AccountHarness, IAccountGateway } from './account-ports.ts';
import type { FleetApiClient } from './ports.ts';

const FLEET_MACHINE_PATH = '/v1/fleet/machine';
const FLEET_COMPONENTS_PATH = '/v1/fleet/components';
const FLEET_PROFILES_PATH = '/v1/fleet/profiles';
const FLEET_RUNTIMES_PATH = '/v1/fleet/runtimes';
const FLEET_CREDENTIALS_PATH = '/v1/fleet/credentials';
const FLEET_PROPOSALS_PATH = '/v1/fleet/proposals';
const FLEET_SETUP_SCAN_PATH = '/v1/fleet/setup/scan';
const FLEET_TOOLS_INSTALL_PATH = '/v1/fleet/machine/tools/install';
const FLEET_EXPORT_PATH = '/v1/fleet/export';
const FLEET_LOGIN_PATH = '/v1/fleet/login';

/**
 * Installing a harness runs a package manager, and the route answers when it is done. A minute is
 * the client's ordinary patience for nothing; this gets ten.
 */
export const TOOL_INSTALL_TIMEOUT_MS = 10 * 60_000;

const segment = (value: string): string => encodeURIComponent(value);

/**
 * Speaks the account-model routes through the protocol client, parsing every answer through the
 * shared schema, which has no field a credential could occupy.
 *
 * THIS CLASS HOLDS NO AUTHORITY. A write is not confirmed by anything the command line carries: the
 * daemon governs a caller by how it arrived, and a caller on this machine is ungoverned.
 */
export class ProtocolAccountGateway implements IAccountGateway {
  constructor(private readonly client: FleetApiClient) {}

  async machine(): Promise<FleetMachineView> {
    return await this.client.request(FLEET_MACHINE_PATH, FleetMachineViewSchema);
  }

  async components(): Promise<FleetComponentCatalog> {
    return await this.client.request(FLEET_COMPONENTS_PATH, FleetComponentCatalogSchema);
  }

  async profiles(): Promise<FleetLayeredProfileCatalog> {
    return await this.client.request(FLEET_PROFILES_PATH, FleetLayeredProfileCatalogSchema);
  }

  async runtimes(): Promise<FleetRuntimeCatalog> {
    return await this.client.request(FLEET_RUNTIMES_PATH, FleetRuntimeCatalogSchema);
  }

  async credentials(): Promise<FleetCredentialList> {
    return await this.client.request(FLEET_CREDENTIALS_PATH, FleetCredentialListSchema);
  }

  async check(credentialId: string): Promise<FleetCredentialView> {
    return await this.client.request(
      `${FLEET_CREDENTIALS_PATH}/${segment(credentialId)}/check`,
      FleetCredentialViewSchema,
      post(FleetCredentialCheckRequestSchema.parse({})),
    );
  }

  async test(credentialId: string, allowInference: boolean): Promise<FleetCredentialTestResult> {
    return await this.client.request(
      `${FLEET_CREDENTIALS_PATH}/${segment(credentialId)}/test`,
      FleetCredentialTestResultSchema,
      post(FleetCredentialTestRequestSchema.parse(allowInference ? { allowInference } : {})),
    );
  }

  async presets(): Promise<FleetProviderPresetCatalog> {
    return await this.client.request(FLEET_PRESETS_PATH, FleetProviderPresetCatalogSchema, GET);
  }

  async stage(change: FleetAccountChange): Promise<FleetAccountChangeView> {
    return await this.client.request(
      FLEET_PROPOSALS_PATH,
      FleetAccountChangeViewSchema,
      post(FleetAccountChangeRequestSchema.parse({ change })),
    );
  }

  async apply(changeId: string): Promise<FleetAccountChangeOutcome> {
    return await this.client.request(
      `${FLEET_PROPOSALS_PATH}/${segment(changeId)}/apply`,
      FleetAccountChangeOutcomeSchema,
      post(FleetProposalApplyRequestSchema.parse({})),
    );
  }

  async scan(): Promise<FleetSetupScan> {
    return await this.client.request(FLEET_SETUP_SCAN_PATH, FleetSetupScanSchema, GET);
  }

  async installTools(harnesses: readonly AccountHarness[]): Promise<FleetToolInstallResult> {
    return await this.client.request(
      FLEET_TOOLS_INSTALL_PATH,
      FleetToolInstallResultSchema,
      post(FleetToolInstallRequestSchema.parse({ harnesses: [...harnesses] })),
      TOOL_INSTALL_TIMEOUT_MS,
    );
  }

  async exportBundle(): Promise<FleetCloneBundle> {
    return await this.client.request(FLEET_EXPORT_PATH, FleetCloneBundleSchema, GET);
  }

  async startSignIn(
    credentialId: string,
    method?: HarnessLoginCodexMethod,
    restart?: boolean,
  ): Promise<HarnessLoginFlow> {
    const request = {
      credentialId,
      ...(method === undefined ? {} : { method }),
      ...(restart === true ? { restart } : {}),
    };
    return await this.client.request(
      FLEET_LOGIN_PATH,
      HarnessLoginFlowSchema,
      post(HarnessLoginStartRequestSchema.parse(request)),
    );
  }

  async signInStatus(flowId: string): Promise<HarnessLoginFlow> {
    return await this.client.request(`${FLEET_LOGIN_PATH}/${segment(flowId)}`, HarnessLoginFlowSchema, GET);
  }

  async submitSignInCode(flowId: string, code: string): Promise<HarnessLoginSubmission> {
    return await this.client.request(
      `${FLEET_LOGIN_PATH}/${segment(flowId)}`,
      HarnessLoginSubmissionSchema,
      post(HarnessLoginSubmitRequestSchema.parse({ code })),
    );
  }

  async cancelSignIn(flowId: string): Promise<HarnessLoginFlow> {
    return await this.client.request(`${FLEET_LOGIN_PATH}/${segment(flowId)}`, HarnessLoginFlowSchema, {
      method: 'DELETE',
    });
  }
}

const GET: RequestInit = { method: 'GET' };

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
