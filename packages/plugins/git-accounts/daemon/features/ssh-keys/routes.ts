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
  GitGpgKeyResultSchema,
  GitKeyResultSchema,
  GPG_KEY_BLOCK_MAX,
} from '../../../contract/index.ts';
import type { GpgKeyService } from '../gpg-keys/service.ts';
import type { SshKeyService } from './service.ts';

/** A key request is a purpose and, at most, one public key line, or (GPG) an armored secret key to keep. */
const MAX_BODY_BYTES = GPG_KEY_BLOCK_MAX + 1024;

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
    throw new ApiError(
      400,
      'a key request is a purpose and optionally a public key (or, for a GPG signing key, a format and an optional key block)',
      GIT_ACCOUNT_CODES.invalidRequest,
    );
  return parsed.data;
}

/** `POST /v1/git-accounts/:id/keys` and `DELETE /v1/git-accounts/:id/keys/:purpose`. Answers are public facts only. */
export function sshKeyRoutes(keys: SshKeyService, gpg: GpgKeyService) {
  return {
    'POST /v1/git-accounts/:id/keys': async (call: CallContext) => {
      const id = accountOf(call);
      const request = await requestOf(call);
      return request.format === 'gpg'
        ? jsonResponse(GitGpgKeyResultSchema.parse(await gpg.create(id, request)))
        : jsonResponse(GitKeyResultSchema.parse(await keys.create(id, request)));
    },
    'DELETE /v1/git-accounts/:id/keys/:purpose': async (call: CallContext) => {
      const kind = GitKeyKindSchema.safeParse(decodeParameter(call.params.get('purpose') ?? ''));
      if (!kind.success) throw new ApiError(404, 'a key purpose is auth or signing', GIT_ACCOUNT_CODES.invalidRequest);
      const id = accountOf(call);
      const removed = await keys.remove(id, kind.data, gpg);
      return jsonResponse(GitKeyRemovedSchema.parse(removed));
    },
  } satisfies Record<string, RouteHandler>;
}
