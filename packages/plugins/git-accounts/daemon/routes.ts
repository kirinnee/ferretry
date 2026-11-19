import {
  decodeParameter,
  ApiError,
  type CallContext,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  GIT_ACCOUNT_CODES,
  GitAccountIdSchema,
  GitAccountListSchema,
  GitAccountRemovedSchema,
  GitDeviceFlowSchema,
  GitDeviceFlowStatusSchema,
  GitFlowIdSchema,
} from '../contract/index.ts';
import type { GithubDeviceFlows } from './lib/device-flow.ts';
import type { GitAccountsService } from './lib/service.ts';

function flowIdOf(call: CallContext): string {
  const id = GitFlowIdSchema.safeParse(decodeParameter(call.params.get('flowId') ?? ''));
  if (!id.success) throw new ApiError(404, 'no such sign-in is open', GIT_ACCOUNT_CODES.unknownFlow);
  return id.data;
}

export function gitAccountRoutes(flows: GithubDeviceFlows, accounts: GitAccountsService) {
  return {
    'POST /v1/git-accounts/github/device': async () => jsonResponse(GitDeviceFlowSchema.parse(await flows.start())),
    'GET /v1/git-accounts/github/device/:flowId': async (call: CallContext) =>
      jsonResponse(GitDeviceFlowStatusSchema.parse(await flows.poll(flowIdOf(call)))),
    'GET /v1/git-accounts': async () => jsonResponse(GitAccountListSchema.parse(await accounts.list())),
    'DELETE /v1/git-accounts/:id': async (call: CallContext) => {
      const id = GitAccountIdSchema.safeParse(decodeParameter(call.params.get('id') ?? ''));
      if (!id.success) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
      return jsonResponse(GitAccountRemovedSchema.parse(await accounts.remove(id.data)));
    },
  } satisfies Record<string, RouteHandler>;
}
