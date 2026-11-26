import type { AuditActor, AuditDraft } from '@ferretry/core-gate/contract';
import { auditKind } from '@ferretry/core-gate/contract';
import {
  decodeParameter,
  ApiError,
  type CallContext,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  GIT_ACCOUNT_AUDIT,
  GIT_ACCOUNT_CODES,
  GitAccountIdSchema,
  GitAccountListSchema,
  GitAccountRemovedSchema,
  GitDeviceFlowSchema,
  GitDeviceFlowStatusSchema,
  GitFlowIdSchema,
  GitConnectRequestSchema,
} from '../contract/index.ts';
import type { GithubDeviceFlows } from './lib/device-flow.ts';
import type { GitAccountsService } from './lib/service.ts';

function flowIdOf(call: CallContext): string {
  const id = GitFlowIdSchema.safeParse(decodeParameter(call.params.get('flowId') ?? ''));
  if (!id.success) throw new ApiError(404, 'no such sign-in is open', GIT_ACCOUNT_CODES.unknownFlow);
  return id.data;
}

/** Who the log says connected the account: from the credential admission derived, never from the request. */
export function actorOf(call: CallContext): AuditActor {
  const credential = (call as { credential?: { tokenClass: string; principal?: { holder: string } } }).credential;
  if (credential === undefined) return { kind: 'anonymous' };
  if (credential.tokenClass === 'device' && credential.principal !== undefined)
    return { kind: 'device', deviceId: credential.principal.holder };
  return credential.tokenClass === 'warden' ? { kind: 'warden' } : { kind: 'host' };
}

export function gitAccountRoutes(
  flows: GithubDeviceFlows,
  accounts: GitAccountsService,
  record: (draft: AuditDraft) => Promise<void>,
) {
  return {
    'POST /v1/git-accounts/github/device': async (call: CallContext) => {
      let value: unknown;
      try {
        const text = await call.request.text(1024);
        value = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new ApiError(400, 'a connect request names a signing format', GIT_ACCOUNT_CODES.invalidRequest);
      }
      const parsed = GitConnectRequestSchema.safeParse(value);
      if (!parsed.success) throw new ApiError(400, 'a signing format is ssh or gpg', GIT_ACCOUNT_CODES.invalidRequest);
      return jsonResponse(GitDeviceFlowSchema.parse(await flows.start(parsed.data.signingFormat)));
    },
    'GET /v1/git-accounts/github/device/:flowId': async (call: CallContext) => {
      const flowId = flowIdOf(call);
      const status = GitDeviceFlowStatusSchema.parse(await flows.poll(flowId));
      // Recorded once per connect (the first poll that sees it done takes it), with the ACCOUNT id as the subject.
      const connected = status.status === 'done' ? flows.takeConnected(flowId) : undefined;
      if (connected !== undefined)
        await record({
          event: auditKind(GIT_ACCOUNT_AUDIT.added),
          actor: actorOf(call),
          subject: connected,
          outcome: 'succeeded',
        }).catch(() => undefined);
      return jsonResponse(status);
    },
    'GET /v1/git-accounts': async () => jsonResponse(GitAccountListSchema.parse(await accounts.list())),
    'DELETE /v1/git-accounts/:id': async (call: CallContext) => {
      const id = GitAccountIdSchema.safeParse(decodeParameter(call.params.get('id') ?? ''));
      if (!id.success) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
      return jsonResponse(GitAccountRemovedSchema.parse(await accounts.remove(id.data)));
    },
  } satisfies Record<string, RouteHandler>;
}
