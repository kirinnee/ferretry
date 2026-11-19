import { ferretOf } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  GhRunAnswerSchema,
  GhRunRequestSchema,
  GIT_ACCOUNT_CODES,
  MAX_GH_ARGS,
  MAX_GH_ARG_LENGTH,
} from '../../../contract/index.ts';
import { actorOf } from '../../routes.ts';
import type { GhRunner } from './gh-runner.ts';

/** The request body: at most every argument at its longest, plus the folder and an account name. */
const MAX_BODY_BYTES = MAX_GH_ARGS * MAX_GH_ARG_LENGTH + 8 * 1024;

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
  const parsed = GhRunRequestSchema.safeParse(json);
  // The refusal names no value: an argument may carry text the caller does not want echoed.
  if (!parsed.success)
    throw new ApiError(
      400,
      'a gh run is an argv, an absolute folder and optionally an account',
      GIT_ACCOUNT_CODES.invalidRequest,
    );
  return parsed.data;
}

/** `POST /v1/git-accounts/gh/run`: Ferretry's `gh`. A refusal is a 200 `{refused}`: a sentence for the caller to print. */
export function ghRunRoutes(runner: GhRunner) {
  return {
    'POST /v1/git-accounts/gh/run': async (call: CallContext) => {
      const ferret = ferretOf(call);
      const answer = await runner.run(
        { actor: actorOf(call), ...(ferret === undefined ? {} : { ferret }) },
        await requestOf(call),
      );
      return jsonResponse(GhRunAnswerSchema.parse(answer));
    },
  } satisfies Record<string, RouteHandler>;
}
