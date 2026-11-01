import {
  HealthViewSchema,
  type SignInRuleDraft,
  SignInRuleDraftSchema,
  type SignInRuleList,
  SignInRuleListSchema,
  type SignInRuleNarrow,
  SignInRuleNarrowSchema,
  type SignInRuleStaged,
  SignInRuleStagedSchema,
  type SignInRuleStageView,
  SignInRuleStageViewSchema,
  type SignInRuleView,
  SignInRuleViewSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { DAEMON_HEALTH_PATH } from '../agenda/gateway.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { IRulesGateway, RulesApiClient } from './ports.ts';

const DroppedSchema = z.looseObject({ dropped: z.literal(true) });
const RevokedSchema = z.looseObject({ revoked: z.literal(true) });

const stagePath = (stage: string): string => `/v1/sign-in-rules/stages/${encodeURIComponent(stage)}`;

/**
 * Speaks the standing sign-in rule routes as the person at this machine, never with a ferret's session header. It has
 * a stage, a confirm-in-app and a view, and NO commit: the commit route needs a passkey proof the machine's token
 * cannot make, so it is the app's alone.
 */
export class ProtocolRulesGateway implements IRulesGateway {
  readonly #headers = { [FY_CLIENT_HEADER]: FY_CLIENT_NAME };
  readonly #json = { 'content-type': 'application/json', ...this.#headers };

  constructor(private readonly client: RulesApiClient) {}

  async list(): Promise<SignInRuleList> {
    return await this.client.request('/v1/sign-in-rules', SignInRuleListSchema, { headers: this.#headers });
  }

  async stage(draft: SignInRuleDraft): Promise<SignInRuleStaged> {
    return await this.client.request('/v1/sign-in-rules/stages', SignInRuleStagedSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(SignInRuleDraftSchema.parse(draft)),
    });
  }

  async confirmInApp(stage: string): Promise<SignInRuleStaged> {
    return await this.client.request(`${stagePath(stage)}/confirm-in-app`, SignInRuleStagedSchema, {
      method: 'POST',
      headers: this.#headers,
    });
  }

  async view(stage: string): Promise<SignInRuleStageView> {
    return await this.client.request(stagePath(stage), SignInRuleStageViewSchema, { headers: this.#headers });
  }

  async drop(stage: string): Promise<void> {
    await this.client.request(stagePath(stage), DroppedSchema, { method: 'DELETE', headers: this.#headers });
  }

  async narrow(rule: string, narrow: SignInRuleNarrow): Promise<SignInRuleView> {
    return await this.client.request(`/v1/sign-in-rules/${encodeURIComponent(rule)}/narrow`, SignInRuleViewSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(SignInRuleNarrowSchema.parse(narrow)),
    });
  }

  async revoke(rule: string): Promise<void> {
    await this.client.request(`/v1/sign-in-rules/${encodeURIComponent(rule)}`, RevokedSchema, {
      method: 'DELETE',
      headers: this.#headers,
    });
  }

  async features(): Promise<readonly string[]> {
    const health = await this.client.request(DAEMON_HEALTH_PATH, HealthViewSchema).catch(() => undefined);
    return health?.features ?? [];
  }
}
