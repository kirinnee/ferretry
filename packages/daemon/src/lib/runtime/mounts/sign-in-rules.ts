import {
  type AccountId,
  AccountIdSchema,
  SIGN_IN_RULE_ERROR_CODES,
  type SignInId,
  SignInIdSchema,
  SignInRuleDraftSchema,
  SignInRuleEligibilitySchema,
  type SignInRuleId,
  SignInRuleIdSchema,
  SignInRuleListSchema,
  SignInRuleNarrowSchema,
  SignInRuleStagedSchema,
  type SignInRuleStageId,
  SignInRuleStageIdSchema,
  SignInRuleStageViewSchema,
  SignInRuleViewSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { PasteRuleCaller } from '../../secure-copy/rules.ts';
import { SignInRuleError, SignInRuleProofMissing, type SignInRuleService } from '../../sign-in-rules/service.ts';
import { ownerActorOf } from './input-requests.ts';
import { refusedAccountNames, refusedPageInput } from './secret-write-grant.ts';

/**
 * THE OWNER'S STANDING SIGN-IN RULE ROUTES (docs/secrets.md, "Standing sign-in rules"): read the rules, stage one,
 * approve it with a passkey, narrow it, revoke it.
 *
 * ## A FERRET NEVER MAKES, WIDENS OR READS A RULE: THREE WALLS
 *
 * 1. Every route here is `caller: 'person'`: a ferret's session credential (or the admin token naming a ferret's
 *    session, or a warden) is refused `owner_only` by the route spine before a body is read.
 * 2. The service refuses `{ kind: 'agent' }` again, on the credential class, never a header.
 * 3. A rule is committed only with the KEPT `approve-sign-in-rule` assertion whose challenge was derived from exactly
 *    the staged body (`claimStoredProof`), from every caller. The commit never reads `governance`, an unlock or
 *    `stepUpOnActions`, so the machine's own token, which holds no passkey, can never commit one.
 *
 * A rule names the owner's accounts (labels, usernames, places) and says whether the owner's own taps qualify a
 * sign-in, so every route needs `secrets.use`, as `GET /v1/accounts` does. Staging, confirming and committing LOOSEN
 * what any ferret may do unasked (Ferretry types a password into a page), so they need `secrets.configure` and
 * `browser.use` too. Those are decided BEFORE the proof is claimed, so a refusal never spends it. Dropping a stage,
 * narrowing and revoking only take away and need `secrets.use`.
 */

const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };
const SECRETS_CONFIGURE: CapabilityDemand = { capability: 'secrets', axis: 'configure' };
const USE = { minimum: 'operator', caller: 'person', capability: SECRETS_USE, noStore: true } as const;
const CONFIGURE = { minimum: 'operator', caller: 'person', capability: SECRETS_CONFIGURE, noStore: true } as const;

/** A refusal of the service, in the person's words and a code to branch on. */
function answered(error: unknown): never {
  if (error instanceof SignInRuleError) throw new ApiError(error.status, error.message, error.code);
  throw error;
}

/** A synchronous service call, its refusal answered in the person's words. */
function owned<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    return answered(error);
  }
}

const owner = (context: RouteContext): PasteRuleCaller => ({ kind: 'owner', actor: ownerActorOf(context) });

/** The stage in the path. One this daemon could never have minted is simply not waiting. */
function stageOf(context: RouteContext): SignInRuleStageId {
  const parsed = SignInRuleStageIdSchema.safeParse(context.params.get('stage') ?? '');
  if (!parsed.success)
    throw new ApiError(
      404,
      'that standing rule is not waiting for a passkey: stage it again',
      SIGN_IN_RULE_ERROR_CODES.stageNotFound,
    );
  return parsed.data;
}

function ruleOf(context: RouteContext): SignInRuleId {
  const parsed = SignInRuleIdSchema.safeParse(context.params.get('id') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the rule in the path is not usable', 'bad_request');
  return parsed.data;
}

function accountOf(context: RouteContext): AccountId {
  const parsed = AccountIdSchema.safeParse(decodeParameter(context.params.get('id') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the account name in the path is not usable', 'invalid_account_id');
  return parsed.data;
}

/** `?signIn=`: required for eligibility, optional for the list. */
function signInQuery(context: RouteContext, required: true): SignInId;
function signInQuery(context: RouteContext, required: false): SignInId | undefined;
function signInQuery(context: RouteContext, required: boolean): SignInId | undefined {
  const raw = context.request.query.get('signIn')?.[0];
  if (raw === undefined && !required) return undefined;
  const parsed = SignInIdSchema.safeParse(raw ?? '');
  if (!parsed.success) throw new ApiError(400, 'name a sign-in as ?signIn=si_…', 'bad_request');
  return parsed.data;
}

/** The extra demands of a route that names accounts and loosens what fills a page: `undefined` when allowed. */
const refusedLoosening = (context: RouteContext): ApiResponse | undefined =>
  refusedAccountNames(context, 'read the accounts a standing rule names') ??
  refusedPageInput(context, 'approve a sign-in into a page in advance');

/**
 * The commit's refusal without a proof: the ordinary step-up demand, naming `approve-sign-in-rule`, so the app runs the
 * ceremony for this stage and sends the commit again. The machine's own token gets it too: it proves nothing.
 */
const proofDemand = (): ApiResponse =>
  jsonResponse(
    {
      error: 'approving a standing sign-in rule needs a passkey confirmation for this one rule, from a paired device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...SECRETS_CONFIGURE, act: STEP_UP_ACTS.approveSignInRule },
    } satisfies StepUpRequiredBody,
    403,
  );

export function signInRuleRoutes(rules: SignInRuleService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sign-in-rules',
      ...USE,
      handle: async context => {
        const names = refusedAccountNames(context, 'read the standing sign-in rules');
        if (names !== undefined) return names;
        const signIn = signInQuery(context, false);
        return jsonResponse(SignInRuleListSchema.parse(await rules.list(owner(context), signIn).catch(answered)));
      },
    },
    {
      method: 'GET',
      path: '/v1/sign-in-rules/eligibility',
      ...USE,
      handle: async context => {
        const names = refusedAccountNames(context, 'ask whether a sign-in can have a standing rule');
        if (names !== undefined) return names;
        const signIn = signInQuery(context, true);
        return jsonResponse(
          SignInRuleEligibilitySchema.parse(await rules.eligibility(owner(context), signIn).catch(answered)),
        );
      },
    },
    {
      // STAGE: builds the body and holds it for its passkey. Approves nothing.
      method: 'POST',
      path: '/v1/sign-in-rules/stages',
      ...CONFIGURE,
      handle: async context => {
        const caller = owner(context);
        const refused = refusedLoosening(context);
        if (refused !== undefined) return refused;
        const draft = await parseBody(context.request, SignInRuleDraftSchema);
        return jsonResponse(SignInRuleStagedSchema.parse(await rules.stage(caller, draft).catch(answered)), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/sign-in-rules/stages/:stage',
      ...USE,
      handle: async context => {
        const caller = owner(context);
        const stage = stageOf(context);
        const names = refusedAccountNames(context, 'read a staged standing rule');
        if (names !== undefined) return names;
        return jsonResponse(SignInRuleStageViewSchema.parse(owned(() => rules.viewStage(caller, stage))));
      },
    },
    {
      // A rule staged at the machine (`fy rules add`) shown in the app, for a paired device's passkey.
      method: 'POST',
      path: '/v1/sign-in-rules/stages/:stage/confirm-in-app',
      ...CONFIGURE,
      handle: async context => {
        const caller = owner(context);
        const stage = stageOf(context);
        const refused = refusedLoosening(context);
        if (refused !== undefined) return refused;
        return jsonResponse(SignInRuleStagedSchema.parse(owned(() => rules.confirmInApp(caller, stage))), 201);
      },
    },
    {
      // A paired device TAKES a machine stage to approve it with its own passkey: gated like the commit, so a device
      // that could not commit can't take the stage from the owner's phone. Asking for passkey options binds nothing.
      method: 'POST',
      path: '/v1/sign-in-rules/stages/:stage/bind',
      ...CONFIGURE,
      handle: async context => {
        const caller = owner(context);
        const stage = stageOf(context);
        const refused = refusedLoosening(context);
        if (refused !== undefined) return refused;
        return jsonResponse(SignInRuleStagedSchema.parse(await rules.bind(caller, stage).catch(answered)), 201);
      },
    },
    {
      // COMMIT: only the KEPT `approve-sign-in-rule` assertion over this stage's bytes, from every caller.
      method: 'POST',
      path: '/v1/sign-in-rules/stages/:stage/commit',
      ...CONFIGURE,
      handle: async context => {
        const caller = owner(context);
        const stage = stageOf(context);
        // Every demand that could refuse is decided first: no proof is spent on a refusal.
        const refused = refusedLoosening(context);
        if (refused !== undefined) return refused;
        try {
          // EVERY CALLER proves it: no `governance` read for the proof, so the machine's token skips nothing.
          const made = await rules.commit(caller, stage, challenge =>
            context.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, challenge),
          );
          return jsonResponse(SignInRuleViewSchema.parse(made), 201);
        } catch (error) {
          if (error instanceof SignInRuleProofMissing) return proofDemand();
          return answered(error);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/v1/sign-in-rules/stages/:stage',
      ...USE,
      handle: async context => {
        const caller = owner(context);
        const stage = stageOf(context);
        owned(() => rules.drop(caller, stage));
        return jsonResponse({ stage, dropped: true });
      },
    },
    {
      // NARROW: drop the code, end earlier, lower the cap. No passkey: it only takes away.
      method: 'POST',
      path: '/v1/sign-in-rules/:id/narrow',
      ...USE,
      handle: async context => {
        const caller = owner(context);
        const id = ruleOf(context);
        const names = refusedAccountNames(context, 'narrow a standing sign-in rule');
        if (names !== undefined) return names;
        const narrow = await parseBody(context.request, SignInRuleNarrowSchema);
        return jsonResponse(SignInRuleViewSchema.parse(await rules.narrow(caller, id, narrow).catch(answered)));
      },
    },
    {
      // REVOKE: one tap, no passkey.
      method: 'DELETE',
      path: '/v1/sign-in-rules/:id',
      ...USE,
      handle: async context => {
        const caller = owner(context);
        const id = ruleOf(context);
        await rules.revoke(caller, id).catch(answered);
        return jsonResponse({ id, revoked: true });
      },
    },
    {
      // REVOKE every rule of one account, one tap, no passkey.
      method: 'POST',
      path: '/v1/accounts/:id/sign-in-rules/revoke',
      ...USE,
      handle: async context => {
        const caller = owner(context);
        const account = accountOf(context);
        const { revoked } = await rules.revokeAccount(caller, account).catch(answered);
        return jsonResponse({ account, revoked });
      },
    },
  ];
}
