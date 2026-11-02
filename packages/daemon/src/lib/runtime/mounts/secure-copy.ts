import {
  type CopyMeta,
  CopyPlanApproveSchema,
  type CopyPlanList,
  PASTE_RULE_ERROR_CODES,
  PASTE_RULE_REFUSAL_WORDS,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleSchema,
  type PasteRuleStageDropped,
  type PasteRuleStageId,
  PasteRuleStageIdSchema,
  type PasteRuleStageList,
  PasteRuleStageListSchema,
  PasteRuleStagedSchema,
  PasteRuleStageViewSchema,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  taskPlanLineOfCopyItem,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiResponse } from '../../api/http.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { PasteRuleProofMissing, PasteRuleStageGone, type PasteRuleStages } from '../../secure-copy/rule-stages.ts';
import type { PasteRuleCaller, PasteRuleService } from '../../secure-copy/rules.ts';
import type { TaskPlanService } from '../../task-plans/service.ts';
import { ownerActorOf } from './input-requests.ts';
import { refusedPageInput, refusedSecretWrite, spentSecretWrite } from './secret-write-grant.ts';
import { taskPlanAnswered } from './task-plans.ts';

/**
 * THE OWNER'S ROUTES FOR SECURE COPY (docs/secure-copy.md): the copies a session holds (descriptions only), the
 * rules that approve pastes in advance, and the plans ferrets asked about.
 *
 * ## MAKING A PASTE RULE: A PASSKEY BOUND TO THAT ONE RULE (owner decision !A244)
 *
 * A rule is STAGED (`POST /v1/copy-rules/stages`, which answers the daemon's own line and rows of what it allows) and
 * made only by its commit, with a fresh `approve-paste-rule` proof bound to that stage, from EVERY caller: the commit
 * never reads `governance`, a held step-up window, an unlock or "ask again for each act", so the machine's own token,
 * which holds no passkey, never makes one. `fy copy rules add` stages at the machine and waits for the app. The old
 * one-step `POST /v1/copy-rules` makes nothing and says so. Removing a rule only narrows, and asks nothing more.
 *
 * ## OWNER ONLY, TWICE
 *
 * An agent caller (`peer:`, `warden:`) is refused before a body is read, and the services refuse again. Adding a
 * rule or approving a plan LOOSENS what agents may do unasked, so those demand `terminal.configure`, and a rule's commit
 * a passkey bound to it (below). Removing a rule only narrows, so it demands
 * `terminal.use`. No route returns a copy's value: the copies list is {@link CopyMeta}, and no schema here has a
 * field for one.
 *
 * ## THE SETTINGS: ON ONLY WITH A PASSKEY BOUND TO WHAT IT WIDENS
 *
 * Turning `allowProfileTargets` ON widens every terminal paste rule a program in the owner's profile could satisfy, so
 * it is staged like a rule (`POST /v1/copy-rules/settings/stages`, rows: the rules it widens) and committed only with a
 * fresh `allow-profile-targets` proof bound to that stage and that list, from every caller (secrev-1334 M2, under
 * !A244). `PUT /v1/copy-rules/settings` turning it on makes nothing and says so; turning it OFF only narrows, and asks
 * no more than `terminal.use`.
 */

const ruleOwner = (context: RouteContext): PasteRuleCaller => ({
  kind: 'owner',
  actor: ownerActorOf(context, 'makes or changes a paste rule'),
});

const ID = /^[0-9a-f]{32}$/u;

function stageParam(context: RouteContext): PasteRuleStageId {
  const parsed = PasteRuleStageIdSchema.safeParse(context.params.get('stage') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the stage in the path is not usable', 'bad_request');
  return parsed.data;
}

/** A stage that is not waiting, as one sentence; anything else is the plans' and rules' own answer. */
function stageAnswered(error: unknown): never {
  if (error instanceof PasteRuleStageGone) throw new ApiError(404, error.message, error.code);
  return taskPlanAnswered(error);
}

/** What a rule's destination demands beyond `terminal.configure`: a write into the secret store, or into a page. */
function refusedDestination(context: RouteContext, request: PasteRuleCreate): ApiResponse | undefined {
  return request.to.kind === 'secret'
    ? refusedSecretWrite(context, 'approve pastes into the secret store')
    : request.to.kind === 'browser'
      ? refusedPageInput(context, 'approve pastes into a page')
      : undefined;
}

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

/** The rules a program from the owner's profile could satisfy now, as rules: what turning profile targets on widens. */
async function widenedBy(
  homes: RuleProgramHomes | undefined,
  list: readonly PasteRule[],
): Promise<readonly PasteRule[]> {
  const ids = new Set(await profileRulesOf(homes, [...list]));
  return list.filter(rule => ids.has(rule.id));
}

/** The commit's refusal without a bound proof, naming the act, so the app runs the ceremony for this stage. */
const stageProofDemand = (act: typeof STEP_UP_ACTS.approvePasteRule | typeof STEP_UP_ACTS.allowProfileTargets) =>
  jsonResponse(
    {
      error:
        act === STEP_UP_ACTS.approvePasteRule
          ? 'making a paste rule needs a passkey confirmation for this one rule, from a paired device'
          : 'letting paste rules use programs in your own profile needs a passkey confirmation for this one change, from a paired device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'terminal', axis: 'configure', act },
    } satisfies StepUpRequiredBody,
    403,
  );

export function secureCopyRoutes(
  copies: CopyListing,
  rules: PasteRuleService,
  plans: TaskPlanService,
  stages: PasteRuleStages,
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
        // Turning it ON is staged with its own bound passkey now: this one-step write only narrows or keeps.
        if (loosens)
          throw new ApiError(
            409,
            PASTE_RULE_REFUSAL_WORDS.profile_targets_passkey_needed,
            PASTE_RULE_ERROR_CODES.profileTargetsPasskeyNeeded,
          );
        return jsonResponse(await rules.changeSettings(caller, settings).catch(taskPlanAnswered));
      },
    },
    {
      // STAGE turning profile targets on: rows are the rules it widens now. Nothing changes until its passkey commits it.
      method: 'POST',
      path: '/v1/copy-rules/settings/stages',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        if (rules.currentSettings(caller).allowProfileTargets)
          throw new ApiError(409, 'programs in your own profile are already allowed: nothing to approve', 'conflict');
        const staged = await stages.stageProfileTargets(caller, await widenedBy(homes, rules.list(caller)));
        return jsonResponse(PasteRuleStagedSchema.parse(staged), 201);
      },
    },
    {
      // COMMIT: only a fresh `allow-profile-targets` proof bound to this stage and the rules it widens, from every caller.
      method: 'POST',
      path: '/v1/copy-rules/settings/stages/:stage/commit',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const stage = stageParam(context);
        const widensNow = (await widenedBy(homes, rules.list(caller))).map(rule => rule.id);
        try {
          const settings = await stages.commitProfileTargets(
            caller,
            stage,
            widensNow,
            subject => context.claimFreshStepUp?.(STEP_UP_ACTS.allowProfileTargets, subject) === true,
          );
          return jsonResponse(PasteRuleSettingsSchema.parse(settings));
        } catch (error) {
          if (error instanceof PasteRuleProofMissing) return stageProofDemand(STEP_UP_ACTS.allowProfileTargets);
          return stageAnswered(error);
        }
      },
    },
    {
      // THE OLD ONE-STEP CREATE makes nothing: a paste rule is made only by a staged commit with its own passkey. An app
      // or `fy` from before !A244 is told to update rather than looping on a step-up it can never satisfy.
      method: 'POST',
      path: '/v1/copy-rules',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        ruleOwner(context);
        throw new ApiError(
          409,
          PASTE_RULE_REFUSAL_WORDS.paste_rule_passkey_needed,
          PASTE_RULE_ERROR_CODES.passkeyNeeded,
        );
      },
    },
    {
      // STAGE: nothing is allowed yet. Answers the daemon's own line and rows, which the passkey prompt lists.
      method: 'POST',
      path: '/v1/copy-rules/stages',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const request = await parseBody(context.request, PasteRuleCreateSchema);
        const refused = refusedDestination(context, request);
        if (refused !== undefined) return refused;
        return jsonResponse(PasteRuleStagedSchema.parse(await stages.stage(caller, request)), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-rules/stages',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const body: PasteRuleStageList = { stages: [...stages.waiting(ruleOwner(context))] };
        return jsonResponse(PasteRuleStageListSchema.parse(body));
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-rules/stages/:stage',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        try {
          return jsonResponse(PasteRuleStageViewSchema.parse(stages.view(caller, stageParam(context))));
        } catch (error) {
          return stageAnswered(error);
        }
      },
    },
    {
      // COMMIT: only a fresh `approve-paste-rule` proof bound to this stage, from every caller, the machine included.
      method: 'POST',
      path: '/v1/copy-rules/stages/:stage/commit',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const stage = stageParam(context);
        let request: PasteRuleCreate | undefined;
        try {
          request = stages.requestOf(caller, stage);
        } catch (error) {
          return stageAnswered(error);
        }
        const refused = refusedDestination(context, request);
        if (refused !== undefined) return refused;
        try {
          // EVERY CALLER proves it: no `governance` read for the proof, so the machine's token skips nothing.
          const rule = await stages.commit(
            caller,
            stage,
            subject => context.claimFreshStepUp?.(STEP_UP_ACTS.approvePasteRule, subject) === true,
          );
          if (request.to.kind === 'secret') spentSecretWrite(context);
          return jsonResponse(PasteRuleSchema.parse(rule), 201);
        } catch (error) {
          if (error instanceof PasteRuleProofMissing) return stageProofDemand(STEP_UP_ACTS.approvePasteRule);
          return stageAnswered(error);
        }
      },
    },
    {
      // TAKE a stage the machine made (`fy copy rules add`, `fy copy rules profile on`): this paired device holds it from
      // now on, and only it gets its challenge and may commit it (secrev-1334 L1). It approves nothing.
      method: 'POST',
      path: '/v1/copy-rules/stages/:stage/bind',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        try {
          return jsonResponse(PasteRuleStagedSchema.parse(stages.bind(caller, stageParam(context))));
        } catch (error) {
          return stageAnswered(error);
        }
      },
    },
    {
      // DROP: the prompt was dismissed, or the owner denied it. Nothing is allowed, so it asks no more than `use`.
      method: 'DELETE',
      path: '/v1/copy-rules/stages/:stage',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use', narrowing: true },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const stage = stageParam(context);
        try {
          stages.drop(caller, stage);
        } catch (error) {
          return stageAnswered(error);
        }
        return jsonResponse({ stage, dropped: true } satisfies PasteRuleStageDropped);
      },
    },
    {
      method: 'DELETE',
      path: '/v1/copy-rules/:ruleId',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use', narrowing: true },
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
        const refused =
          (into('secret') ? refusedSecretWrite(context, 'approve pastes into the secret store') : undefined) ??
          (into('browser') ? refusedPageInput(context, 'approve pastes into a page') : undefined);
        if (refused !== undefined) return refused;
        // Only a decline is answered here now: allowing a paste needs the plan's bound passkey (owner ruling on !A244),
        // so a tick is refused `409 needs_passkey` and nothing is written.
        return jsonResponse(
          await plans.approveCopyItems(caller, sessionId, planId, body.items).catch(taskPlanAnswered),
        );
      },
    },
  ];
}
