import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type HarnessLoginCodexMethod,
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  LoginCheckRequestSchema,
  type LoginList,
  LoginListSchema,
  type LoginTestResult,
  LoginTestRequestSchema,
  LoginTestResultSchema,
  type LoginView,
  LoginViewSchema,
  type ModelCatalogRefreshResult,
  ModelCatalogRefreshResultSchema,
  type ModelCatalogsView,
  ModelCatalogsViewSchema,
  type ProviderPresetCatalog,
  ProviderPresetCatalogSchema,
} from '../../contract/index.ts';
import type { ILoginsGateway } from './ports.ts';

/** The route keys the manifest declares; a typo here is a missing route, not a 404 at run time. */
export const ROUTES = {
  logins: 'GET /v1/logins',
  check: 'POST /v1/logins/:loginId/check',
  test: 'POST /v1/logins/:loginId/test',
  presets: 'GET /v1/logins/presets',
  models: 'GET /v1/models',
  refreshModels: 'POST /v1/models/refresh',
  signInStart: 'POST /v1/logins/sign-in',
  signInStatus: 'GET /v1/logins/sign-in/:flowId',
  signInSubmit: 'POST /v1/logins/sign-in/:flowId',
  signInCancel: 'DELETE /v1/logins/sign-in/:flowId',
} as const;

/**
 * Speaks the login routes through the plugin client, parsing every answer through the shared schema, which has no
 * field a token could occupy. THIS CLASS HOLDS NO AUTHORITY: the daemon governs a caller by how it arrived.
 *
 * GAP(kernel): `PluginClient.call` takes no timeout; the client's own patience applies.
 */
export class ClientLoginsGateway implements ILoginsGateway {
  constructor(private readonly client: PluginClient) {}

  async logins(): Promise<LoginList> {
    return LoginListSchema.parse(await this.client.call(ROUTES.logins));
  }

  async check(loginId: string): Promise<LoginView> {
    const body = LoginCheckRequestSchema.parse({});
    return LoginViewSchema.parse(await this.client.call(ROUTES.check, { params: { loginId }, body }));
  }

  async test(loginId: string, allowInference: boolean): Promise<LoginTestResult> {
    const body = LoginTestRequestSchema.parse(allowInference ? { allowInference } : {});
    return LoginTestResultSchema.parse(await this.client.call(ROUTES.test, { params: { loginId }, body }));
  }

  async presets(): Promise<ProviderPresetCatalog> {
    return ProviderPresetCatalogSchema.parse(await this.client.call(ROUTES.presets));
  }

  async models(): Promise<ModelCatalogsView> {
    return ModelCatalogsViewSchema.parse(await this.client.call(ROUTES.models));
  }

  async refreshModels(): Promise<ModelCatalogRefreshResult> {
    return ModelCatalogRefreshResultSchema.parse(await this.client.call(ROUTES.refreshModels));
  }

  async startSignIn(loginId: string, method?: HarnessLoginCodexMethod, restart?: boolean): Promise<HarnessLoginFlow> {
    const body = HarnessLoginStartRequestSchema.parse({
      loginId,
      ...(method === undefined ? {} : { method }),
      ...(restart === true ? { restart } : {}),
    });
    return HarnessLoginFlowSchema.parse(await this.client.call(ROUTES.signInStart, { body }));
  }

  async signInStatus(flowId: string): Promise<HarnessLoginFlow> {
    return HarnessLoginFlowSchema.parse(await this.client.call(ROUTES.signInStatus, { params: { flowId } }));
  }

  async submitSignInCode(flowId: string, code: string): Promise<HarnessLoginSubmission> {
    const body = HarnessLoginSubmitRequestSchema.parse({ code });
    return HarnessLoginSubmissionSchema.parse(
      await this.client.call(ROUTES.signInSubmit, { params: { flowId }, body }),
    );
  }

  async recheckSignIn(flowId: string): Promise<HarnessLoginSubmission> {
    const body = HarnessLoginSubmitRequestSchema.parse({ method: 'recheck' });
    return HarnessLoginSubmissionSchema.parse(
      await this.client.call(ROUTES.signInSubmit, { params: { flowId }, body }),
    );
  }

  async cancelSignIn(flowId: string): Promise<HarnessLoginFlow> {
    return HarnessLoginFlowSchema.parse(await this.client.call(ROUTES.signInCancel, { params: { flowId } }));
  }
}
