import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  type HarnessLoginCodexMethod,
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  type LoginChange,
  type LoginChangeOutcome,
  LoginChangeOutcomeSchema,
  LoginChangeSchema,
  type LoginChangeView,
  LoginChangeViewSchema,
  type LoginBudget,
  LoginBudgetSchema,
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
import { authorityOf, type ChangeAuthority, GRANTS_ROUTE } from './authority.ts';
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
  stage: 'POST /v1/logins/changes',
  apply: 'POST /v1/logins/changes/:changeId/apply',
} as const;

/**
 * Usage's budgets read. Logins cannot import Usage (Usage imports Logins), so the standing a login's row shows is
 * read here from Usage's own route and parsed against Logins' own budget shape. A caller or machine without it
 * (Usage off, a refusal) shows no budget line, as a login with no budget does.
 */
export const BUDGETS_ROUTE = 'GET /v1/usage/budgets' as const;
const BudgetsReadSchema = z.object({ budgets: z.array(z.object({ login: z.string(), budget: LoginBudgetSchema })) });

/**
 * Speaks the login routes through the plugin client, parsing every answer through the shared schema, which has no
 * field a token could occupy. THIS CLASS HOLDS NO AUTHORITY: the daemon governs a caller by how it arrived.
 *
 * GAP(kernel): `PluginClient.call` takes no timeout; the client's own patience applies.
 */
export class ClientLoginsGateway implements ILoginsGateway {
  constructor(private readonly client: PluginClient) {}

  async logins(): Promise<LoginList> {
    const list = LoginListSchema.parse(await this.client.call(ROUTES.logins));
    const budgets = await this.budgets();
    return { ...list, logins: list.logins.map(login => withBudget(login, budgets)) };
  }

  async check(loginId: string): Promise<LoginView> {
    const body = LoginCheckRequestSchema.parse({});
    const view = LoginViewSchema.parse(await this.client.call(ROUTES.check, { params: { loginId }, body }));
    return withBudget(view, await this.budgets());
  }

  /** Every budgeted login's standing, by id; empty when Usage cannot say (a missing budget line is not an error). */
  private async budgets(): Promise<ReadonlyMap<string, LoginBudget>> {
    try {
      const read = BudgetsReadSchema.safeParse(await this.client.call(BUDGETS_ROUTE));
      return new Map(read.success ? read.data.budgets.map(entry => [entry.login, entry.budget]) : []);
    } catch {
      return new Map();
    }
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

  /** An answer this build cannot read is the stricter reading (`undetermined`); a failed read is the caller's to see. */
  async authority(): Promise<ChangeAuthority> {
    return authorityOf(await this.client.call(GRANTS_ROUTE));
  }

  async stage(change: LoginChange): Promise<LoginChangeView> {
    const body = LoginChangeSchema.parse(change);
    return LoginChangeViewSchema.parse(await this.client.call(ROUTES.stage, { body }));
  }

  async apply(changeId: string): Promise<LoginChangeOutcome> {
    return LoginChangeOutcomeSchema.parse(await this.client.call(ROUTES.apply, { params: { changeId } }));
  }
}

/** A login's view with its budget standing, when it has one. A login the daemon already put a budget on keeps it. */
function withBudget(login: LoginView, budgets: ReadonlyMap<string, LoginBudget>): LoginView {
  const budget = login.budget ?? budgets.get(login.id);
  return budget === undefined ? login : { ...login, budget };
}
