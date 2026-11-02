import {
  type CopyMeta,
  CopyPlanApproveSchema,
  type CopyPlanList,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  taskPlanLineOfCopyItem,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { grantRefusalCode } from '../../api/capability.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { PasteRuleCaller, PasteRuleService } from '../../secure-copy/rules.ts';
import type { TaskPlanService } from '../../task-plans/service.ts';
import { ownerActorOf } from './input-requests.ts';
import { refusedPageInput, refusedSecretWrite, spentSecretWrite } from './secret-write-grant.ts';
import { taskPlanAnswered } from './task-plans.ts';

/**
 * THE OWNER'S ROUTES FOR SECURE COPY (docs/secure-copy.md): the copies a session holds (descriptions only), the
 * rules that approve pastes in advance, and the plans ferrets asked about.
 *
 * ## OWNER ONLY, TWICE
 *
 * An agent caller (`peer:`, `warden:`) is refused before a body is read, and the services refuse again. Adding a
 * rule or approving a plan LOOSENS what agents may do unasked, so those demand `terminal.configure`: a remote
 * device follows the owner's "ask again for each change" setting. Removing a rule only narrows, so it demands
 * `terminal.use`. No route returns a copy's value: the copies list is {@link CopyMeta}, and no schema here has a
 * field for one.
 *
 * ## THE SETTINGS: LOOSEN AT THE MACHINE, OR WITH A PASSKEY
 *
 * `PUT /v1/copy-rules/settings` is owner only like every route here. Turning `allowProfileTargets` ON loosens what
 * a rule matches, so a governed (remote) device needs `terminal.configure` AND a passkey proved for that one act
 * (`allow-profile-targets`), which this route then spends. Turning it OFF only narrows, and asks no more than
 * `terminal.use`.
 */

const ruleOwner = (context: RouteContext): PasteRuleCaller => ({
  kind: 'owner',
  actor: ownerActorOf(context, 'makes or changes a paste rule'),
});

const ID = /^[0-9a-f]{32}$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function param(context: RouteContext, name: string, shape: RegExp): string {
  const value = context.params.get(name) ?? '';
  if (!shape.test(value)) throw new ApiError(400, `the ${name} in the path is not usable`, 'bad_request');
  return value;
}

/** The copies a session holds, as the owner may read them: descriptions, never values. */
export interface CopyListing {
  list(sessionId: string): readonly CopyMeta[];
}

/** Whether a program from the owner's own profile could satisfy a terminal rule for `program` (profile-program.ts). */
export interface RuleProgramHomes {
  profileCouldStandFor(program: string): Promise<boolean>;
}

/**
 * The terminal rules a program from the owner's profile could satisfy: the same check the profile proof makes, so the
 * badge holds whatever the profile holds today. A look that fails marks the rule, since it cannot be ruled out.
 */
async function profileRulesOf(homes: RuleProgramHomes | undefined, list: PasteRuleList['rules']): Promise<string[]> {
  if (homes === undefined) return [];
  const found = await Promise.all(
    list.map(async rule =>
      rule.to.kind === 'terminal' && (await homes.profileCouldStandFor(rule.to.program).catch(() => true))
        ? [rule.id]
        : [],
    ),
  );
  return found.flat();
}

/**
 * Whether this caller may turn profile targets ON: at the machine, or from a device holding `terminal.configure` with
 * a passkey proved for this act. Answers the refusal, or `undefined` when allowed.
 */
function profileTargetsRefusal(context: RouteContext): ReturnType<typeof jsonResponse> | undefined {
  const governance = context.governance;
  if (governance?.governed === false) return undefined;
  const decision = governance?.decide({ capability: 'terminal', axis: 'configure' });
  if (decision !== undefined && !decision.allowed && decision.refusal !== 'step-up-required')
    return jsonResponse(
      { error: 'this device may not let copy rules paste into your profile', code: grantRefusalCode(decision.refusal) },
      403,
    );
  // Claimed, not read: a proof stamped for THIS act, taken in one step, so a proof for another act or a second request
  // racing on the same one never turns this on.
  if (decision === undefined || context.claimFreshStepUp?.(STEP_UP_ACTS.allowProfileTargets) !== true)
    return jsonResponse(
      {
        error:
          'letting copy rules paste into programs in your own profile needs a passkey confirmation for this change',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'terminal', axis: 'configure', act: STEP_UP_ACTS.allowProfileTargets },
      } satisfies StepUpRequiredBody,
      403,
    );
  return undefined;
}

export function secureCopyRoutes(
  copies: CopyListing,
  rules: PasteRuleService,
  plans: TaskPlanService,
  homes?: RuleProgramHomes,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/copies',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        ruleOwner(context);
        return jsonResponse({ copies: [...copies.list(param(context, 'sessionId', SESSION))] });
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-rules',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const body: PasteRuleList = { rules: [...rules.list(caller)] };
        return jsonResponse(body);
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-rules/settings',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const body: PasteRuleSettingsView = {
          settings: rules.currentSettings(caller),
          profileRules: await profileRulesOf(homes, [...rules.list(caller)]),
        };
        return jsonResponse(body);
      },
    },
    {
      method: 'PUT',
      path: '/v1/copy-rules/settings',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const settings = await parseBody(context.request, PasteRuleSettingsSchema);
        const loosens = settings.allowProfileTargets && !rules.currentSettings(caller).allowProfileTargets;
        const refused = loosens ? profileTargetsRefusal(context) : undefined;
        if (refused !== undefined) return refused;
        return jsonResponse(await rules.changeSettings(caller, settings).catch(taskPlanAnswered));
      },
    },
    {
      method: 'POST',
      path: '/v1/copy-rules',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const request = await parseBody(context.request, PasteRuleCreateSchema);
        const intoStore = request.to.kind === 'secret';
        const refused = intoStore
          ? refusedSecretWrite(context, 'approve pastes into the secret store')
          : request.to.kind === 'browser'
            ? refusedPageInput(context, 'approve pastes into a page')
            : undefined;
        if (refused !== undefined) return refused;
        const rule = await rules.create(caller, request).catch(taskPlanAnswered);
        if (intoStore) spentSecretWrite(context);
        return jsonResponse(rule, 201);
      },
    },
    {
      method: 'DELETE',
      path: '/v1/copy-rules/:ruleId',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        await rules.revoke(caller, param(context, 'ruleId', ID)).catch(taskPlanAnswered);
        return jsonResponse({ removed: true });
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-plans',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        // The task plans waiting with paste lines, as paste plans: their paste lines only, numbered as items.
        const body: CopyPlanList = { plans: [...plans.copyPlans(ruleOwner(context))] };
        return jsonResponse(body);
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/copy-plans/:planId/approve',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const body = await parseBody(context.request, CopyPlanApproveSchema);
        const sessionId = param(context, 'sessionId', SESSION);
        const planId = param(context, 'planId', ID);
        // An item is a PASTE ITEM number, read back into its plan line, never a line number: item 0 is never line 0.
        const plan = plans.copyPlans(caller, sessionId).some(candidate => candidate.id === planId)
          ? plans.get(caller, sessionId, planId)
          : undefined;
        const into = (kind: string) =>
          body.items.some(index => {
            const line = plan === undefined ? undefined : plan.lines[taskPlanLineOfCopyItem(plan, index) ?? -1];
            return line?.kind === 'paste' && line.to.kind === kind;
          });
        const intoStore = into('secret');
        const refused =
          (intoStore ? refusedSecretWrite(context, 'approve pastes into the secret store') : undefined) ??
          (into('browser') ? refusedPageInput(context, 'approve pastes into a page') : undefined);
        if (refused !== undefined) return refused;
        const answer = await plans.approveCopyItems(caller, sessionId, planId, body.items).catch(taskPlanAnswered);
        if (intoStore) spentSecretWrite(context);
        return jsonResponse(answer);
      },
    },
  ];
}
