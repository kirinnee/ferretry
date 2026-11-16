import { z } from 'zod';
import {
  type CopyMeta,
  CopyMetaSchema,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleListSchema,
  type PasteRuleSettings,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  PasteRuleSettingsViewSchema,
  type PasteRuleStaged,
  PasteRuleStagedSchema,
  type PasteRuleStageView,
  PasteRuleStageViewSchema,
  type TaskPlan,
  type TaskPlanApproval,
  type TaskPlanApprovalAnswer,
  TaskPlanApprovalAnswerSchema,
  TaskPlanApprovalSchema,
  type TaskPlanConfirming,
  TaskPlanConfirmingSchema,
  type TaskPlanList,
  TaskPlanListSchema,
  TaskPlanRevokeSchema,
  TaskPlanSchema,
  type TaskPlanStageView,
  TaskPlanStageViewSchema,
} from '../../../contract/routes/index.ts';
import { callDaemon } from '../../shell.ts';
import type { CopyApiClient, ICopyGateway, IPlanGateway } from './ports.ts';

const CopiesSchema = z.strictObject({ copies: z.array(CopyMetaSchema) });
const RemovedSchema = z.strictObject({ removed: z.literal(true) });

/**
 * Speaks the secure-copy routes as the person at this machine, through the plugin's generated client (which never
 * sends a ferret's credential): approving pastes is the owner's. Every reply is parsed against the contract; none of
 * them has a field for a value.
 */
export class ProtocolCopyGateway implements ICopyGateway {
  constructor(private readonly client: CopyApiClient) {}

  async copies(sessionId: string): Promise<readonly CopyMeta[]> {
    const listed = await callDaemon(this.client, 'GET /v1/ferrets/:ferretId/copies', {
      params: { ferretId: sessionId },
    });
    return CopiesSchema.parse(listed).copies;
  }

  async rules(): Promise<PasteRuleList> {
    return PasteRuleListSchema.parse(await callDaemon(this.client, 'GET /v1/copy-rules'));
  }

  async ruleSettings(): Promise<PasteRuleSettingsView> {
    return PasteRuleSettingsViewSchema.parse(await callDaemon(this.client, 'GET /v1/copy-rules/settings'));
  }

  async changeRuleSettings(settings: PasteRuleSettings): Promise<PasteRuleSettings> {
    return PasteRuleSettingsSchema.parse(
      await callDaemon(this.client, 'PUT /v1/copy-rules/settings', { body: PasteRuleSettingsSchema.parse(settings) }),
    );
  }

  async stageRule(rule: PasteRuleCreate): Promise<PasteRuleStaged> {
    return PasteRuleStagedSchema.parse(
      await callDaemon(this.client, 'POST /v1/copy-rules/stages', { body: PasteRuleCreateSchema.parse(rule) }),
    );
  }

  async stageProfileTargets(): Promise<PasteRuleStaged> {
    return PasteRuleStagedSchema.parse(await callDaemon(this.client, 'POST /v1/copy-rules/settings/stages'));
  }

  async ruleStage(stage: string): Promise<PasteRuleStageView> {
    return PasteRuleStageViewSchema.parse(
      await callDaemon(this.client, 'GET /v1/copy-rules/stages/:stage', { params: { stage } }),
    );
  }

  async removeRule(id: string): Promise<void> {
    RemovedSchema.parse(await callDaemon(this.client, 'DELETE /v1/copy-rules/:ruleId', { params: { ruleId: id } }));
  }
}

/**
 * Speaks the task-plan routes as the person at this machine. It has a stage, a confirm-in-app and a view, and NO
 * commit: the commit route needs a passkey proof the machine's token cannot make, so it is the app's alone.
 */
export class ProtocolPlanGateway implements IPlanGateway {
  constructor(private readonly client: CopyApiClient) {}

  async plans(session?: string): Promise<TaskPlanList> {
    return TaskPlanListSchema.parse(
      await callDaemon(this.client, 'GET /v1/accounts/plans', session === undefined ? {} : { query: { session } }),
    );
  }

  async stage(sessionId: string, planId: string, approval: TaskPlanApproval): Promise<TaskPlanApprovalAnswer> {
    return TaskPlanApprovalAnswerSchema.parse(
      await callDaemon(this.client, 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval', {
        params: { ferretId: sessionId, planId },
        body: TaskPlanApprovalSchema.parse(approval),
      }),
    );
  }

  async confirmInApp(sessionId: string, planId: string, stage: string): Promise<TaskPlanConfirming> {
    return TaskPlanConfirmingSchema.parse(
      await callDaemon(this.client, 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/confirm-in-app', {
        params: { ferretId: sessionId, planId, stage },
      }),
    );
  }

  async view(sessionId: string, planId: string, stage: string): Promise<TaskPlanStageView> {
    return TaskPlanStageViewSchema.parse(
      await callDaemon(this.client, 'GET /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage', {
        params: { ferretId: sessionId, planId, stage },
      }),
    );
  }

  async revoke(sessionId: string, planId: string, lines?: readonly number[]): Promise<TaskPlan> {
    return TaskPlanSchema.parse(
      await callDaemon(this.client, 'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke', {
        params: { ferretId: sessionId, planId },
        body: TaskPlanRevokeSchema.parse(lines === undefined ? {} : { lines }),
      }),
    );
  }
}
