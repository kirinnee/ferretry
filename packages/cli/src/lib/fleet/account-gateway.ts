import {
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
  type FleetCredentialView,
  FleetCredentialViewSchema,
  type FleetLayeredProfileCatalog,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineView,
  FleetMachineViewSchema,
  FleetProposalApplyRequestSchema,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetSetupScan,
  FleetSetupScanSchema,
  FleetToolInstallRequestSchema,
  type FleetToolInstallResult,
  FleetToolInstallResultSchema,
  GrantUnlockRequestSchema,
  GrantUnlockViewSchema,
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { AccountAuthority, AccountHarness, IAccountGateway } from './account-ports.ts';
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
const GRANT_UNLOCK_PATH = '/v1/grants/unlock';

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
 * THE UNLOCK AND THE PASSWORD ARE NEVER RETAINED. Each is handed to one call and forgotten: this class
 * has no field for either.
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

  async unlock(password: string): Promise<string> {
    const minted = await this.client.request(
      GRANT_UNLOCK_PATH,
      GrantUnlockViewSchema,
      post(GrantUnlockRequestSchema.parse({ password }), {}),
    );
    return minted.token;
  }

  async check(credentialId: string, authority: AccountAuthority): Promise<FleetCredentialView> {
    return await this.client.request(
      `${FLEET_CREDENTIALS_PATH}/${segment(credentialId)}/check`,
      FleetCredentialViewSchema,
      post(FleetCredentialCheckRequestSchema.parse(withPassword({}, authority)), authority),
    );
  }

  async stage(change: FleetAccountChange, authority: AccountAuthority): Promise<FleetAccountChangeView> {
    return await this.client.request(
      FLEET_PROPOSALS_PATH,
      FleetAccountChangeViewSchema,
      post(FleetAccountChangeRequestSchema.parse({ change }), authority),
    );
  }

  async apply(changeId: string, authority: AccountAuthority): Promise<FleetAccountChangeOutcome> {
    return await this.client.request(
      `${FLEET_PROPOSALS_PATH}/${segment(changeId)}/apply`,
      FleetAccountChangeOutcomeSchema,
      post(FleetProposalApplyRequestSchema.parse(withPassword({}, authority)), authority),
    );
  }

  async scan(authority: AccountAuthority): Promise<FleetSetupScan> {
    return await this.client.request(FLEET_SETUP_SCAN_PATH, FleetSetupScanSchema, get(authority));
  }

  async installTools(
    harnesses: readonly AccountHarness[],
    authority: AccountAuthority,
  ): Promise<FleetToolInstallResult> {
    return await this.client.request(
      FLEET_TOOLS_INSTALL_PATH,
      FleetToolInstallResultSchema,
      post(FleetToolInstallRequestSchema.parse(withPassword({ harnesses: [...harnesses] }, authority)), authority),
      TOOL_INSTALL_TIMEOUT_MS,
    );
  }

  async exportBundle(authority: AccountAuthority): Promise<FleetCloneBundle> {
    return await this.client.request(FLEET_EXPORT_PATH, FleetCloneBundleSchema, get(authority));
  }

  async startSignIn(credentialId: string, authority: AccountAuthority): Promise<HarnessLoginFlow> {
    return await this.client.request(
      FLEET_LOGIN_PATH,
      HarnessLoginFlowSchema,
      post(HarnessLoginStartRequestSchema.parse(withPassword({ credentialId }, authority)), authority),
    );
  }

  async signInStatus(flowId: string, authority: AccountAuthority): Promise<HarnessLoginFlow> {
    return await this.client.request(`${FLEET_LOGIN_PATH}/${segment(flowId)}`, HarnessLoginFlowSchema, get(authority));
  }

  async submitSignInCode(flowId: string, code: string, authority: AccountAuthority): Promise<HarnessLoginSubmission> {
    return await this.client.request(
      `${FLEET_LOGIN_PATH}/${segment(flowId)}`,
      HarnessLoginSubmissionSchema,
      post(HarnessLoginSubmitRequestSchema.parse({ code }), authority),
    );
  }

  async cancelSignIn(flowId: string, authority: AccountAuthority): Promise<HarnessLoginFlow> {
    return await this.client.request(`${FLEET_LOGIN_PATH}/${segment(flowId)}`, HarnessLoginFlowSchema, {
      method: 'DELETE',
      headers: unlockHeaders(authority),
    });
  }
}

const unlockHeaders = (authority: AccountAuthority): Record<string, string> =>
  authority.unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: authority.unlock };

const get = (authority: AccountAuthority): RequestInit => ({ method: 'GET', headers: unlockHeaders(authority) });

const post = (body: unknown, authority: AccountAuthority): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...unlockHeaders(authority) },
  body: JSON.stringify(body),
});

const withPassword = <T extends object>(body: T, authority: AccountAuthority): T & { operatorPassword?: string } =>
  authority.password === undefined ? body : { ...body, operatorPassword: authority.password };
