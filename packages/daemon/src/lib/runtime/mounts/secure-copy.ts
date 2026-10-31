import {
  type CopyMeta,
  CopyPlanApproveSchema,
  type CopyPlanList,
  PasteRuleCreateSchema,
  type PasteRuleList,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SecureCopyError } from '../../secure-copy/errors.ts';
import type { CopyPlanService } from '../../secure-copy/plans.ts';
import type { PasteRuleCaller, PasteRuleService } from '../../secure-copy/rules.ts';
import { ownerActorOf } from './input-requests.ts';
import { refusedPageInput, refusedSecretWrite, spentSecretWrite } from './secret-write-grant.ts';

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

function answered(error: unknown): never {
  if (error instanceof SecureCopyError) throw new ApiError(STATUS[error.code], error.message, error.code);
  throw error;
}

const ruleOwner = (context: RouteContext): PasteRuleCaller => ({ kind: 'owner', actor: ownerActorOf(context) });

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

export function secureCopyRoutes(
  copies: CopyListing,
  rules: PasteRuleService,
  plans: CopyPlanService,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/copies',
      minimum: 'operator',
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
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const body: PasteRuleList = { rules: [...rules.list(ruleOwner(context))] };
        return jsonResponse(body);
      },
    },
    {
      method: 'POST',
      path: '/v1/copy-rules',
      minimum: 'operator',
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
        const rule = await rules.create(caller, request).catch(answered);
        if (intoStore) spentSecretWrite(context);
        return jsonResponse(rule, 201);
      },
    },
    {
      method: 'DELETE',
      path: '/v1/copy-rules/:ruleId',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        await rules.revoke(caller, param(context, 'ruleId', ID)).catch(answered);
        return jsonResponse({ removed: true });
      },
    },
    {
      method: 'GET',
      path: '/v1/copy-plans',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const body: CopyPlanList = { plans: [...plans.list(ruleOwner(context))] };
        return jsonResponse(body);
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/copy-plans/:planId/approve',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const caller = ruleOwner(context);
        const body = await parseBody(context.request, CopyPlanApproveSchema);
        const sessionId = param(context, 'sessionId', SESSION);
        const planId = param(context, 'planId', ID);
        const plan = plans.list(caller, sessionId).find(candidate => candidate.id === planId);
        const into = (kind: string) => body.items.some(index => plan?.items[index]?.to.kind === kind);
        const intoStore = into('secret');
        const refused =
          (intoStore ? refusedSecretWrite(context, 'approve pastes into the secret store') : undefined) ??
          (into('browser') ? refusedPageInput(context, 'approve pastes into a page') : undefined);
        if (refused !== undefined) return refused;
        const answer = await plans.approve(caller, sessionId, planId, body.items).catch(answered);
        if (intoStore) spentSecretWrite(context);
        return jsonResponse(answer);
      },
    },
  ];
}
