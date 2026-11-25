import type { AuthenticatedCredential } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { MCP_TOKEN_CODES, McpTokenAnswerSchema, McpTokenRequestSchema } from '../../../contract/index.ts';
import { parseBody } from '../../lib/body.ts';
import { type FerretMcpTokens, McpTokenRefusal } from './service.ts';

/**
 * The ferret the credential on this call belongs to. ONLY a ferret's own session credential counts: the admin token
 * with a ferret named in a header (which any holder of that token can write), a device, the warden and a person are
 * all `undefined`, so none of them is the ferret the path names.
 */
const credentialFerret = (call: CallContext & { readonly credential?: AuthenticatedCredential }): string | undefined =>
  call.credential?.tokenClass === 'ferret' ? call.credential.ferret : undefined;

/**
 * `POST /v1/ferrets/:ferretId/mcp/token`: governed as `secrets.use` (it hands out a credential), and then ONLY the ferret
 * itself: a person, a device, the warden, the admin token and another ferret all get a 403, so the one thing this adds to
 * what a ferret could already read from its own environment is that same token, renewed.
 */
export function tokenRoutes(tokens: Pick<FerretMcpTokens, 'headers'>): {
  readonly 'POST /v1/ferrets/:ferretId/mcp/token': RouteHandler;
} {
  return {
    'POST /v1/ferrets/:ferretId/mcp/token': async call => {
      const id = decodeParameter(call.params.get('ferretId') ?? '');
      if (id === undefined || id === '')
        throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
      if (credentialFerret(call) !== id)
        throw new ApiError(
          403,
          'only the ferret itself may ask for its MCP sign-in token; a person or another ferret signs in through Ferretry instead',
          MCP_TOKEN_CODES.notThisFerret,
        );
      const request = await parseBody(call.request, McpTokenRequestSchema);
      try {
        return jsonResponse(McpTokenAnswerSchema.parse(await tokens.headers(id, request.variable)));
      } catch (error) {
        if (error instanceof McpTokenRefusal) throw new ApiError(error.status, error.message, error.code);
        throw error;
      }
    },
  };
}
