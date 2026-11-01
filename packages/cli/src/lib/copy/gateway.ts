import {
  type CopyMeta,
  CopyMetaSchema,
  type CopyPlan,
  CopyPlanApproveSchema,
  type CopyPlanList,
  CopyPlanListSchema,
  CopyPlanSchema,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleListSchema,
  type PasteRuleSettingsView,
  PasteRuleSettingsViewSchema,
  PasteRuleSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { CopyApiClient, ICopyGateway } from './ports.ts';

const CopiesSchema = z.strictObject({ copies: z.array(CopyMetaSchema) });
const RemovedSchema = z.strictObject({ removed: z.literal(true) });

/**
 * Speaks the secure-copy routes as the person at this machine, never with a ferret's session header: approving
 * pastes is the owner's. Every reply is parsed against the protocol; none of them has a field for a value.
 */
export class ProtocolCopyGateway implements ICopyGateway {
  readonly #headers = { [FY_CLIENT_HEADER]: FY_CLIENT_NAME };
  readonly #json = { 'content-type': 'application/json', ...this.#headers };

  constructor(private readonly client: CopyApiClient) {}

  async copies(sessionId: string): Promise<readonly CopyMeta[]> {
    const listed = await this.client.request(`/v1/sessions/${encodeURIComponent(sessionId)}/copies`, CopiesSchema, {
      headers: this.#headers,
    });
    return listed.copies;
  }

  async rules(): Promise<PasteRuleList> {
    return await this.client.request('/v1/copy-rules', PasteRuleListSchema, { headers: this.#headers });
  }

  async ruleSettings(): Promise<PasteRuleSettingsView> {
    return await this.client.request('/v1/copy-rules/settings', PasteRuleSettingsViewSchema, {
      headers: this.#headers,
    });
  }

  async addRule(rule: PasteRuleCreate): Promise<PasteRule> {
    return await this.client.request('/v1/copy-rules', PasteRuleSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
    });
  }

  async removeRule(id: string): Promise<void> {
    await this.client.request(`/v1/copy-rules/${encodeURIComponent(id)}`, RemovedSchema, {
      method: 'DELETE',
      headers: this.#headers,
    });
  }

  async plans(): Promise<CopyPlanList> {
    return await this.client.request('/v1/copy-plans', CopyPlanListSchema, { headers: this.#headers });
  }

  async approve(sessionId: string, planId: string, items: readonly number[]): Promise<CopyPlan> {
    return await this.client.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/copy-plans/${encodeURIComponent(planId)}/approve`,
      CopyPlanSchema,
      { method: 'POST', headers: this.#json, body: JSON.stringify(CopyPlanApproveSchema.parse({ items })) },
    );
  }
}
