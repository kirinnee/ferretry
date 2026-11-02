import {
  type CopyMeta,
  CopyMetaSchema,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleListSchema,
  type PasteRuleSettings,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  PasteRuleSettingsViewSchema,
  PasteRuleSchema,
  type PasteRuleStaged,
  PasteRuleStagedSchema,
  type PasteRuleStageView,
  PasteRuleStageViewSchema,
  type TaskPlan,
  type TaskPlanApproval,
  TaskPlanApprovalSchema,
  type TaskPlanApprovalAnswer,
  TaskPlanApprovalAnswerSchema,
  type TaskPlanConfirming,
  TaskPlanConfirmingSchema,
  type TaskPlanList,
  TaskPlanListSchema,
  TaskPlanRevokeSchema,
  TaskPlanSchema,
  type TaskPlanStageView,
  TaskPlanStageViewSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { readDaemonFeatures } from '../daemon/features.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { CopyApiClient, ICopyGateway, IPlanGateway } from './ports.ts';

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

  async changeRuleSettings(settings: PasteRuleSettings): Promise<PasteRuleSettings> {
    return await this.client.request('/v1/copy-rules/settings', PasteRuleSettingsSchema, {
      method: 'PUT',
      headers: this.#json,
      body: JSON.stringify(PasteRuleSettingsSchema.parse(settings)),
    });
  }

  async addRule(rule: PasteRuleCreate): Promise<PasteRule> {
    return await this.client.request('/v1/copy-rules', PasteRuleSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
    });
  }

  async stageRule(rule: PasteRuleCreate): Promise<PasteRuleStaged> {
    return await this.client.request('/v1/copy-rules/stages', PasteRuleStagedSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
    });
  }

  async ruleStage(stage: string): Promise<PasteRuleStageView> {
    return await this.client.request(`/v1/copy-rules/stages/${encodeURIComponent(stage)}`, PasteRuleStageViewSchema, {
      headers: this.#headers,
    });
  }

  async features(): Promise<readonly string[]> {
    return await readDaemonFeatures(this.client);
  }

  async removeRule(id: string): Promise<void> {
    await this.client.request(`/v1/copy-rules/${encodeURIComponent(id)}`, RemovedSchema, {
      method: 'DELETE',
      headers: this.#headers,
    });
  }
}

/**
 * Speaks the task-plan routes as the person at this machine. It has a stage, a confirm-in-app and a view, and NO
 * commit: the commit route needs a passkey proof the machine's token cannot make, so it is the app's alone.
 */
export class ProtocolPlanGateway implements IPlanGateway {
  readonly #headers = { [FY_CLIENT_HEADER]: FY_CLIENT_NAME };
  readonly #json = { 'content-type': 'application/json', ...this.#headers };

  constructor(private readonly client: CopyApiClient) {}

  async plans(session?: string): Promise<TaskPlanList> {
    const query = session === undefined ? '' : `?session=${encodeURIComponent(session)}`;
    return await this.client.request(`/v1/task-plans${query}`, TaskPlanListSchema, { headers: this.#headers });
  }

  async stage(sessionId: string, planId: string, approval: TaskPlanApproval): Promise<TaskPlanApprovalAnswer> {
    return await this.client.request(`${planPath(sessionId, planId)}/approval`, TaskPlanApprovalAnswerSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(TaskPlanApprovalSchema.parse(approval)),
    });
  }

  async confirmInApp(sessionId: string, planId: string, stage: string): Promise<TaskPlanConfirming> {
    return await this.client.request(
      `${planPath(sessionId, planId)}/approval/${encodeURIComponent(stage)}/confirm-in-app`,
      TaskPlanConfirmingSchema,
      { method: 'POST', headers: this.#headers },
    );
  }

  async view(sessionId: string, planId: string, stage: string): Promise<TaskPlanStageView> {
    return await this.client.request(
      `${planPath(sessionId, planId)}/approval/${encodeURIComponent(stage)}`,
      TaskPlanStageViewSchema,
      { headers: this.#headers },
    );
  }

  async revoke(sessionId: string, planId: string, lines?: readonly number[]): Promise<TaskPlan> {
    return await this.client.request(`${planPath(sessionId, planId)}/revoke`, TaskPlanSchema, {
      method: 'POST',
      headers: this.#json,
      body: JSON.stringify(TaskPlanRevokeSchema.parse(lines === undefined ? {} : { lines })),
    });
  }

  async features(): Promise<readonly string[]> {
    return await readDaemonFeatures(this.client);
  }
}

const planPath = (sessionId: string, planId: string): string =>
  `/v1/sessions/${encodeURIComponent(sessionId)}/task-plans/${encodeURIComponent(planId)}`;
