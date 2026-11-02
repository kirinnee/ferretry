import {
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
  TASK_PLAN_ERROR_CODES,
  type TaskPlan,
  TaskPlanApprovalAnswerSchema,
  TaskPlanApprovalSchema,
  TaskPlanConfirmingSchema,
  type TaskPlanList,
  TaskPlanRevokeSchema,
  TaskPlanSchema,
  TaskPlanStageDroppedSchema,
  type TaskPlanStageId,
  TaskPlanStageIdSchema,
  TaskPlanStageViewSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SecureCopyError } from '../../secure-copy/errors.ts';
import type { PasteRuleCaller } from '../../secure-copy/rules.ts';
import { TaskPlanError, TaskPlanProofMissing, type TaskPlanService } from '../../task-plans/service.ts';
import { ownerActorOf } from './input-requests.ts';
import { refusedAccountNames, refusedPageInput, refusedSecretWrite, spentSecretWrite } from './secret-write-grant.ts';

/**
 * THE OWNER'S TASK-PLAN ROUTES (docs/secure-copy.md, "Task plans"): read the plans, answer one, and revoke.
 *
 * ## A FERRET NEVER ANSWERS ITS OWN PLAN: THREE WALLS
 *
 * 1. Every route here is `caller: 'person'`: a ferret's session credential (or the admin token naming a ferret's
 *    session, or a warden) is refused `owner_only` by the route spine before a body is read.
 * 2. The service refuses `{ kind: 'agent' }` again, on the credential class, never a header.
 * 3. Any ticked sign-in line is committed only with a fresh `approve-task-plan` passkey proof bound to the staged
 *    selection. The commit never reads `governance`, an unlock or `stepUpOnActions`, so the machine's own token, which
 *    holds no passkey, can never commit one: "a passkey at the machine" means confirming in the app.
 *
 * Answering LOOSENS what a ferret may do unasked, so the stage, commit and confirm demand `terminal.configure`, plus
 * `browser.use` for a page sign-in or a paste into a page and `secrets.configure` for a paste into the store, as the
 * paste-plan route always did. Reading, dropping a stage and revoking only narrow, and demand `terminal.use`.
 *
 * A plan names the owner's accounts (labels, usernames, places) and a stage's summary words them, so every route that
 * answers either also needs `secrets.use`, exactly as `GET /v1/accounts` does: a device denied the accounts reads
 * none of them through a plan.
 */

const STATUS: Readonly<Record<SecureCopyError['code'], number>> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  capacity: 429,
  unavailable: 503,
  upstream_failed: 502,
};

/** A refusal of the service, in the person's words and a code to branch on. */
export function taskPlanAnswered(error: unknown): never {
  if (error instanceof SecureCopyError) throw new ApiError(STATUS[error.code], error.message, error.code);
  if (error instanceof TaskPlanError) throw new ApiError(error.status, error.message, error.code);
  throw error;
}

/** A synchronous service call, its refusal answered in the person's words. */
function owned<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    return taskPlanAnswered(error);
  }
}

const owner = (context: RouteContext): PasteRuleCaller => ({
  kind: 'owner',
  actor: ownerActorOf(context, 'approves or changes a task plan'),
});

const ID = /^[0-9a-f]{32}$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function param(context: RouteContext, name: string, shape: RegExp): string {
  const value = context.params.get(name) ?? '';
  if (!shape.test(value)) throw new ApiError(400, `the ${name} in the path is not usable`, 'bad_request');
  return value;
}

/** The stage in the path. One this daemon could never have minted is simply not waiting. */
function stageOf(context: RouteContext): TaskPlanStageId {
  const parsed = TaskPlanStageIdSchema.safeParse(context.params.get('stage') ?? '');
  if (!parsed.success)
    throw new ApiError(
      404,
      'that task plan selection is not waiting for a passkey',
      TASK_PLAN_ERROR_CODES.stageNotFound,
    );
  return parsed.data;
}

/** What the ticked lines would put where: a value into a page, or a paste into the secret store. */
function reaches(plan: TaskPlan, lines: readonly number[]): { readonly page: boolean; readonly store: boolean } {
  const ticked = lines.flatMap(line => (plan.lines[line] === undefined ? [] : [plan.lines[line]]));
  return {
    page: ticked.some(line => line?.kind === 'sign-in' || (line?.kind === 'paste' && line.to.kind === 'browser')),
    store: ticked.some(line => line?.kind === 'paste' && line.to.kind === 'secret'),
  };
}

/** The extra demands of what the selection reaches, or `undefined` when this caller may. */
function refusedReach(context: RouteContext, reach: ReturnType<typeof reaches>): ApiResponse | undefined {
  return (
    (reach.store ? refusedSecretWrite(context, 'approve pastes into the secret store') : undefined) ??
    (reach.page ? refusedPageInput(context, 'approve sign-ins and pastes into a page') : undefined)
  );
}

/**
 * The commit's refusal without a proof: the ordinary step-up demand, naming `approve-task-plan`, so the app runs the
 * ceremony for this stage and sends the commit again. The machine's own token gets it too: it proves nothing.
 */
const proofDemand = (): ApiResponse =>
  jsonResponse(
    {
      error:
        'approving a sign-in on a task plan needs a passkey confirmation for this one selection, from a paired device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'terminal', axis: 'configure', act: STEP_UP_ACTS.approveTaskPlan },
    } satisfies StepUpRequiredBody,
    403,
  );

const USE = {
  minimum: 'operator',
  caller: 'person',
  capability: { capability: 'terminal', axis: 'use' },
  noStore: true,
} as const;
const CONFIGURE = {
  minimum: 'operator',
  caller: 'person',
  capability: { capability: 'terminal', axis: 'configure' },
  noStore: true,
} as const;

export function taskPlanRoutes(plans: TaskPlanService): readonly ApiRoute[] {
  const at = (context: RouteContext) => ({
    caller: owner(context),
    sessionId: param(context, 'sessionId', SESSION),
    planId: param(context, 'planId', ID),
  });
  return [
    {
      method: 'GET',
      path: '/v1/task-plans',
      ...USE,
      handle: async context => {
        const names = refusedAccountNames(context);
        if (names !== undefined) return names;
        const session = context.request.query.get('session')?.[0];
        if (session !== undefined && !SESSION.test(session))
          throw new ApiError(400, 'the session in the query is not usable', 'bad_request');
        const body: TaskPlanList = { plans: [...plans.list(owner(context), session)] };
        return jsonResponse(body);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/task-plans/:planId',
      ...USE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const names = refusedAccountNames(context);
        if (names !== undefined) return names;
        return jsonResponse(TaskPlanSchema.parse(owned(() => plans.get(caller, sessionId, planId))));
      },
    },
    {
      // STAGE: nothing ticked is a decline, answered at once; any ticked line is held for its passkey (owner ruling on !A244).
      method: 'POST',
      path: '/v1/sessions/:sessionId/task-plans/:planId/approval',
      ...CONFIGURE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const approval = await parseBody(context.request, TaskPlanApprovalSchema);
        const plan = owned(() => plans.get(caller, sessionId, planId));
        const reach = reaches(
          plan,
          approval.lines.map(tick => tick.line),
        );
        const refused = refusedReach(context, reach) ?? refusedAccountNames(context);
        if (refused !== undefined) return refused;
        const answer = await plans.stage(caller, sessionId, planId, approval).catch(taskPlanAnswered);
        return jsonResponse(TaskPlanApprovalAnswerSchema.parse(answer), answer.outcome === 'staged' ? 201 : 200);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/task-plans/:planId/approval/:stage',
      ...USE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const stage = stageOf(context);
        const names = refusedAccountNames(context);
        if (names !== undefined) return names;
        return jsonResponse(
          TaskPlanStageViewSchema.parse(owned(() => plans.viewStage(caller, sessionId, planId, stage))),
        );
      },
    },
    {
      // COMMIT: only a fresh `approve-task-plan` proof bound to this stage, from every caller, the machine included.
      method: 'POST',
      path: '/v1/sessions/:sessionId/task-plans/:planId/approval/:stage/commit',
      ...CONFIGURE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const stage = stageOf(context);
        const view = owned(() => plans.viewStage(caller, sessionId, planId, stage));
        const plan = owned(() => plans.get(caller, sessionId, planId));
        const reach = reaches(plan, view.lines);
        const refused = refusedReach(context, reach) ?? refusedAccountNames(context);
        if (refused !== undefined) return refused;
        try {
          // EVERY CALLER proves it: no `governance` read for the proof, so the machine's token skips nothing.
          const settled = await plans.commit(
            caller,
            sessionId,
            planId,
            stage,
            subject => context.claimFreshStepUp?.(STEP_UP_ACTS.approveTaskPlan, subject) === true,
          );
          if (reach.store) spentSecretWrite(context);
          return jsonResponse(TaskPlanSchema.parse(settled));
        } catch (error) {
          if (error instanceof TaskPlanProofMissing) return proofDemand();
          return taskPlanAnswered(error);
        }
      },
    },
    {
      // A selection staged at the machine (`fy plan approve`) shown on the plan's own card, for the passkey in the app.
      method: 'POST',
      path: '/v1/sessions/:sessionId/task-plans/:planId/approval/:stage/confirm-in-app',
      ...CONFIGURE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const stage = stageOf(context);
        return jsonResponse(
          TaskPlanConfirmingSchema.parse(owned(() => plans.confirmInApp(caller, sessionId, planId, stage))),
          201,
        );
      },
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/task-plans/:planId/approval/:stage',
      ...USE,
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const stage = stageOf(context);
        owned(() => plans.drop(caller, sessionId, planId, stage));
        return jsonResponse(TaskPlanStageDroppedSchema.parse({ stage, dropped: true }));
      },
    },
    {
      // REVOKE: one tap, no passkey; it only narrows.
      method: 'POST',
      path: '/v1/sessions/:sessionId/task-plans/:planId/revoke',
      ...USE,
      // Revoking only takes away: the grant, never a per-act passkey (docs/grants.md § Narrowing never asks again).
      capability: { ...USE.capability, narrowing: true },
      handle: async context => {
        const { caller, sessionId, planId } = at(context);
        const names = refusedAccountNames(context);
        if (names !== undefined) return names;
        const { lines } = await parseBody(context.request, TaskPlanRevokeSchema);
        return jsonResponse(
          TaskPlanSchema.parse(await plans.revoke(caller, sessionId, planId, lines).catch(taskPlanAnswered)),
        );
      },
    },
  ];
}
