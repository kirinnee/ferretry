import {
  ApiError,
  type ApiResponse,
  type CallContext,
  decodeParameter,
  errorResponse,
  jsonResponse,
  parseBody,
  parseOptionalBody,
} from '@ferretry/kernel/contract';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import {
  CONNECTOR_REFUSAL_CODES,
  ConnectorActRequestSchema,
  ConnectorChangeSchema,
  ConnectorGrantIdSchema,
  ConnectorGrantViewSchema,
  ConnectorPendingViewSchema,
  ConnectorRequestRefSchema,
} from '../../contract/index.ts';
import type { ConnectorActResult } from '../lib/ports.ts';
import type { ConnectorService } from '../lib/service.ts';

/**
 * THE OWNER'S HALF (docs/mcp-connector.md "Owner routes"): see what is waiting, approve or deny a sign-in, revoke a
 * grant, switch the connector. Every route is a PERSON's (`caller: 'person'` on the descriptor, so a ferret and the
 * connector's own principal are refused before any handler runs); the handlers add only what a descriptor cannot say.
 *
 * WHO MAY APPROVE. Approving adds access, so a GOVERNED caller (a phone, a browser — even one on the host) must hold
 * `pairing.configure` AND prove a fresh passkey FOR THIS ACT (`approve-connector`), claimed atomically so one
 * confirmation approves one sign-in; a catalog-install or add-device proof never buys a connector. The machine's own
 * admin token over loopback (`fy connector approve`) is ungoverned and asks nothing beyond the credential. Denying and
 * revoking only take access away and ask no proof.
 *
 * WHEN IT IS OFF. `GET` still answers (`enabled: false` and the sentence saying why), and still lists the grants that were
 * given: ending access is never harder than giving it. Approve and deny answer `409 connector_disabled`; revoke works off or on.
 */

const REFUSAL_STATUS = { not_found: 404, expired: 410, already_decided: 409 } as const;
const REFUSAL_CODE = {
  not_found: CONNECTOR_REFUSAL_CODES.notFound,
  expired: CONNECTOR_REFUSAL_CODES.expired,
  already_decided: CONNECTOR_REFUSAL_CODES.alreadyDecided,
} as const;

function refused(result: Exclude<ConnectorActResult<unknown>, { ok: true }>): ApiResponse {
  return errorResponse(REFUSAL_STATUS[result.code], result.message, REFUSAL_CODE[result.code]);
}

/**
 * Claims the passkey proof approving needs. `undefined` means go on: the machine's own caller is ungoverned and needs
 * none. A governed caller without a fresh `approve-connector` proof is told which act to confirm.
 */
function claimApproval(call: CallContext): ApiResponse | undefined {
  if (call.governance?.governed !== true) return undefined;
  if (call.claimFreshStepUp?.(STEP_UP_ACTS.approveConnector) === true) return undefined;
  return jsonResponse(
    {
      error: 'approving a Claude connector needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'pairing', axis: 'configure', act: 'approve-connector' },
    } satisfies StepUpRequiredBody,
    403,
  );
}

const actorOf = (call: CallContext): string => call.actor ?? 'unknown';
const notFoundRequest = (): ApiResponse =>
  errorResponse(404, 'there is no such sign-in waiting', CONNECTOR_REFUSAL_CODES.notFound);

function requestRef(call: CallContext): string | undefined {
  const parsed = ConnectorRequestRefSchema.safeParse(decodeParameter(call.params.get('id') ?? ''));
  return parsed.success ? parsed.data : undefined;
}

export function ownerRoutes(service: ConnectorService) {
  const { authority } = service;
  /** Approve and deny need the connector reachable: otherwise 409 with the sentence that says what to do. */
  const unreachable = async (): Promise<ApiResponse | undefined> => {
    const status = await service.status();
    return status.enabled
      ? undefined
      : errorResponse(409, status.disabledReason ?? 'The connector is off.', CONNECTOR_REFUSAL_CODES.disabled);
  };
  return {
    'GET /v1/connector': async (): Promise<ApiResponse> => jsonResponse(await service.status()),

    'PUT /v1/connector': async (call: CallContext): Promise<ApiResponse> => {
      const change = await parseBody(call.request, ConnectorChangeSchema);
      const result = await service.change(change, actorOf(call));
      if (!result.ok) return errorResponse(409, result.message, CONNECTOR_REFUSAL_CODES.cannotSwitch);
      return jsonResponse(await service.status());
    },

    'POST /v1/connector/requests/:id/approve': async (call: CallContext): Promise<ApiResponse> => {
      await parseOptionalBody(call.request, ConnectorActRequestSchema);
      const ref = requestRef(call);
      if (ref === undefined) return notFoundRequest();
      const off = await unreachable();
      if (off !== undefined) return off;
      const missing = claimApproval(call);
      if (missing !== undefined) return missing;
      const result = await authority.approve(ref, actorOf(call));
      return result.ok ? jsonResponse(ConnectorGrantViewSchema.parse(result.value)) : refused(result);
    },

    'POST /v1/connector/requests/:id/deny': async (call: CallContext): Promise<ApiResponse> => {
      await parseOptionalBody(call.request, ConnectorActRequestSchema);
      const ref = requestRef(call);
      if (ref === undefined) return notFoundRequest();
      const off = await unreachable();
      if (off !== undefined) return off;
      const result = await authority.deny(ref, actorOf(call));
      return result.ok ? jsonResponse(ConnectorPendingViewSchema.parse(result.value)) : refused(result);
    },

    'POST /v1/connector/grants/:id/revoke': async (call: CallContext): Promise<ApiResponse> => {
      await parseOptionalBody(call.request, ConnectorActRequestSchema);
      const grantId = ConnectorGrantIdSchema.safeParse(decodeParameter(call.params.get('id') ?? ''));
      if (!grantId.success) throw new ApiError(404, 'there is no such grant', CONNECTOR_REFUSAL_CODES.notFound);
      // No availability check: ending access is never harder than giving it, off or on.
      const result = await authority.revoke(grantId.data, actorOf(call));
      return result.ok ? jsonResponse(ConnectorGrantViewSchema.parse(result.value)) : refused(result);
    },
  } as const;
}
