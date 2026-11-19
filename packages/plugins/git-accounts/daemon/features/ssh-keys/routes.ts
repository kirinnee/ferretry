import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  GIT_ACCOUNT_CODES,
  GitAccountIdSchema,
  GitKeyKindSchema,
  GitKeyRemovedSchema,
  GitKeyRequestSchema,
  GitKeyResultSchema,
} from '../../../contract/index.ts';
import type { SshKeyService } from './service.ts';

/** A key request is a purpose and, at most, one public key line. */
const MAX_BODY_BYTES = 4 * 1024;

function accountOf(call: CallContext) {
  const id = GitAccountIdSchema.safeParse(decodeParameter(call.params.get('id') ?? ''));
  if (!id.success) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
  return id.data;
}

async function requestOf(call: CallContext) {
  let text: string;
  try {
    text = await call.request.text(MAX_BODY_BYTES);
  } catch {
    throw new ApiError(400, 'the request body could not be read', GIT_ACCOUNT_CODES.invalidRequest);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', GIT_ACCOUNT_CODES.invalidRequest);
  }
  const parsed = GitKeyRequestSchema.safeParse(json);
  // The refusal names no value: a rejected body may hold a pasted private key.
  if (!parsed.success)
    throw new ApiError(400, 'a key request is a purpose and optionally a public key', GIT_ACCOUNT_CODES.invalidRequest);
  return parsed.data;
}

/** `POST /v1/git-accounts/:id/keys` and `DELETE /v1/git-accounts/:id/keys/:purpose`. Answers are public facts only. */
export function sshKeyRoutes(keys: SshKeyService) {
  return {
    'POST /v1/git-accounts/:id/keys': async (call: CallContext) =>
      jsonResponse(GitKeyResultSchema.parse(await keys.create(accountOf(call), await requestOf(call)))),
    'DELETE /v1/git-accounts/:id/keys/:purpose': async (call: CallContext) => {
      const kind = GitKeyKindSchema.safeParse(decodeParameter(call.params.get('purpose') ?? ''));
      if (!kind.success) throw new ApiError(404, 'a key purpose is auth or signing', GIT_ACCOUNT_CODES.invalidRequest);
      return jsonResponse(GitKeyRemovedSchema.parse(await keys.remove(accountOf(call), kind.data)));
    },
  } satisfies Record<string, RouteHandler>;
}
