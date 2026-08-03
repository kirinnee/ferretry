import {
  PairingCodeMintRequestSchema,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  PairingCodeStatusResponseSchema,
  type PairingId,
  PairingIdSchema,
  PairingResponseSchema,
} from '@ferretry/protocol';
import {
  type ApiRequest,
  type ApiRoute,
  decodeParameter,
  errorResponse,
  jsonResponse,
  parseOptionalBody,
} from '../../api/index.ts';
import type { PairingRedemption } from '../../pairing/index.ts';

export interface PairingSubsystem {
  mint(): PairingCodeMintResponse;
  status(pairingId: PairingId): PairingCodeStatusResponse | undefined;
  redeem(value: unknown, rateLimitKey: string): Promise<PairingRedemption>;
}

const refused = () => errorResponse(403, 'pairing refused', 'pairing_refused');

function requireLoopback(request: ApiRequest): ReturnType<typeof errorResponse> | undefined {
  return request.loopback ? undefined : errorResponse(403, 'host-local access required', 'forbidden');
}

async function pairingBody(request: ApiRequest): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    // Syntax, shape and body-read failures deliberately collapse into the same public refusal as a
    // wrong code. The service still performs its constant-time comparison without letting broken
    // uploads spend the daemon-wide code-guess budget.
    return undefined;
  }
}

function rateLimitKey(request: ApiRequest): string {
  return request.clientAddress ?? (request.loopback ? 'loopback-unknown' : 'remote-unknown');
}

export function pairingRoutes(subsystem: PairingSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/pair',
      scope: 'public',
      noStore: true,
      handle: async ({ request }) => {
        const result = await subsystem.redeem(await pairingBody(request), rateLimitKey(request));
        return result.kind === 'paired' ? jsonResponse(PairingResponseSchema.parse(result.response)) : refused();
      },
    },
    {
      method: 'POST',
      path: '/v1/pair/code',
      scope: 'host',
      noStore: true,
      handle: async ({ request }) => {
        const denial = requireLoopback(request);
        if (denial !== undefined) return denial;
        await parseOptionalBody(request, PairingCodeMintRequestSchema);
        return jsonResponse(PairingCodeMintResponseSchema.parse(subsystem.mint()), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/pair/code/:pairingId',
      scope: 'host',
      noStore: true,
      handle: async ({ request, params }) => {
        const denial = requireLoopback(request);
        if (denial !== undefined) return denial;
        const pairingId = PairingIdSchema.safeParse(decodeParameter(params.get('pairingId') ?? ''));
        if (!pairingId.success) return errorResponse(404, 'pairing status not found', 'pairing_status_not_found');
        const status = subsystem.status(pairingId.data);
        return status === undefined
          ? errorResponse(404, 'pairing status not found', 'pairing_status_not_found')
          : jsonResponse(PairingCodeStatusResponseSchema.parse(status));
      },
    },
  ];
}
