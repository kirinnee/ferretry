import { ApiError, type ApiResponse, jsonResponse } from '@ferretry/kernel/contract';
import {
  type PhoneApproval,
  PhoneApprovalIdSchema,
  type PhoneApprovalList,
  PhoneApprovalListSchema,
  PhoneApprovalSchema,
} from '../../../../contract/routes/index.ts';
import { type RouteContext, ownerActorOf, refusedAccountNames } from '../../http/grants.ts';
import type { MountedRoute } from '../../http/routes.ts';
import { PHONE_APPROVAL_STATUS, PhoneApprovalError } from '../../phone-approval/errors.ts';
import type { PhoneApprovalCaller, PhoneApprovalService } from '../../phone-approval/service.ts';

/**
 * THE OWNER'S ROUTES FOR APPROVING A SIGN-IN ON THE PHONE (docs/input-requests.md, "Approve on your phone"): read the
 * approvals the cards are drawn from, and "Not me — stop". Copied from today's `phoneApprovalRoutes`
 * (`runtime/mounts/input-requests.ts`, bb89d054d), with the path moved from `/v1/sessions/:sessionId/…` to
 * `/v1/ferrets/:ferretId/…` (§1.4).
 *
 * - EVERY ROUTE IS A PERSON'S (`caller: 'person'` in the manifest): a ferret's credential, or the admin token naming a
 *   ferret's session, is refused `owner_only` by the route spine before a path is read, and again here by
 *   {@link ownerActorOf}. A ferret learns where ITS approval stands only through `input_wait`, which is bound to the
 *   ferret that raised it.
 * - THERE IS NO ROUTE THAT SETS `moved-on`, and none that approves: only the daemon's own look at the page or terminal
 *   settles a sign-in, so neither the ferret nor the owner can claim one went through. `refuse` only ever ends one.
 * - WITHOUT `secrets.use`, `account`, `username` and `via` are stripped (G90, I206): where and how it is approved stay
 *   (the page's origin, the factor and its number are what the owner checks against the phone), the account's names do not.
 * - Nothing here carries a value, a code or a token: the schema of the answer has no field for one.
 */

const FERRET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** A refusal of the service, in the person's words and a code to branch on. */
function answered(error: unknown): never {
  if (error instanceof PhoneApprovalError)
    throw new ApiError(PHONE_APPROVAL_STATUS[error.code], error.message, error.code);
  throw error;
}

/** An approval as a caller that may not read ACCOUNT NAMES sees it (no `secrets.use`): without the account, its username and provider. */
export function accountless(approval: PhoneApproval): PhoneApproval {
  const { account: _account, username: _username, via: _via, ...rest } = approval;
  return rest;
}

function ferretOf(context: RouteContext): string {
  const value = context.params.get('ferretId') ?? '';
  if (!FERRET.test(value)) throw new ApiError(400, 'the ferret in the path is not usable', 'bad_request');
  return value;
}

function approvalOf(context: RouteContext): string {
  const parsed = PhoneApprovalIdSchema.safeParse(context.params.get('approvalId') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the approval id in the path is not usable', 'bad_request');
  return parsed.data;
}

export function phoneApprovalRoutes(service: PhoneApprovalService): readonly MountedRoute[] {
  const caller = (context: RouteContext): PhoneApprovalCaller => ({
    kind: 'owner',
    actor: ownerActorOf(context, 'sees or answers a phone approval'),
  });
  const shown = (context: RouteContext, approval: PhoneApproval): PhoneApproval =>
    PhoneApprovalSchema.parse(
      refusedAccountNames(context, 'read the accounts an approval names') === undefined
        ? approval
        : accountless(approval),
    );
  const run = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      return answered(error);
    }
  };
  return [
    {
      method: 'GET',
      path: '/v1/phone-approvals',
      handle: async (context): Promise<ApiResponse> => {
        const approvals = run(() => service.list(caller(context)));
        const body: PhoneApprovalList = PhoneApprovalListSchema.parse({
          approvals: approvals.map(each => shown(context, each)),
        });
        return jsonResponse(body);
      },
    },
    {
      method: 'GET',
      path: '/v1/ferrets/:ferretId/phone-approvals/:approvalId',
      handle: async (context): Promise<ApiResponse> => {
        const approval = run(() => service.get(caller(context), ferretOf(context), approvalOf(context)));
        return jsonResponse(shown(context, approval));
      },
    },
    {
      method: 'POST',
      path: '/v1/ferrets/:ferretId/phone-approvals/:approvalId/refuse',
      handle: async (context): Promise<ApiResponse> => {
        const who = caller(context);
        const refused = await service.refuse(who, ferretOf(context), approvalOf(context)).catch(answered);
        return jsonResponse(shown(context, refused));
      },
    },
  ];
}
