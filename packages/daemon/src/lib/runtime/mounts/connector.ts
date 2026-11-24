/**
 * THE OWNER'S HALF OF THE REMOTE MCP CONNECTOR (`docs/mcp-connector.md`): see what is waiting, approve or deny a
 * sign-in, revoke a grant. The authorization server itself — registration, the waiting page, tokens — is not here;
 * this mount only reaches the acts it exposes through {@link ConnectorOwnerActs}.
 *
 * ## EVERY ROUTE IS A PERSON'S
 *
 * `caller: 'person'` on all four, so the boundary refuses a ferret (or a warden) with `403 owner_only` before the
 * minimum, the body or this handler. A grant the connector mints lets another program read and drive the fleet from
 * the internet; a ferret that could approve its own client's sign-in would have handed itself the owner's authority.
 *
 * ## WHO MAY APPROVE
 *
 * Approving ADDS ACCESS, so it asks what every access-adding act asks:
 *
 * - at the machine (the host's admin token on loopback, `fy connector approve`) NOTHING beyond the credential — that
 *   caller already has the machine, and the contract names this as how the end-to-end test approves;
 * - a governed device (a phone, a browser — even one on the host) must hold `pairing.configure` and prove a fresh
 *   passkey FOR THIS ACT (`approve-connector`), claimed atomically so one confirmation approves one sign-in. A
 *   `catalog-install` or `add-device` proof never buys a connector, and the reverse.
 *
 * Denying and revoking only take access away, so they ask `pairing.use` and no proof of their own, declared
 * `narrowing` exactly as a device revocation is: taking access away is never harder than giving it.
 *
 * ## WHAT THE ANSWERS CARRY
 *
 * The strict protocol schemas have no field for a token, a code, a secret or a handle. Every answer is parsed
 * through them, so a view that grew one would fail here (500) rather than reach a client.
 *
 * ## WHEN THE CONNECTOR IS OFF
 *
 * `GET` still answers — `enabled: false` and a sentence saying why and what to do — so `fy connector` and the app can
 * explain it. Approve, deny and revoke answer `409 connector_disabled` with a plain sentence and never touch the acts.
 */
import {
  CONNECTOR_REFUSAL_CODES,
  ConnectorActRequestSchema,
  ConnectorGrantViewSchema,
  ConnectorPendingViewSchema,
  ConnectorGrantIdSchema,
  ConnectorRequestRefSchema,
  ConnectorStatusSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import {
  type ApiResponse,
  type ApiRoute,
  type CapabilityDemand,
  decodeParameter,
  errorResponse,
  jsonResponse,
  parseOptionalBody,
  type RouteContext,
} from '../../api/index.ts';
import type { ConnectorActRefusal, ConnectorActResult, ConnectorOwnerActs } from '../../connector/ports.ts';

/**
 * Whether the connector is on, and where. Read fresh on every request, because the owner may switch it on and the
 * daemon pick that up while the routes are mounted.
 */
export type ConnectorAvailability =
  | { readonly enabled: true; readonly publicUrl: string; readonly mcpUrl: string }
  | { readonly enabled: false; readonly disabledReason: string };

export interface ConnectorSubsystem {
  readonly acts: ConnectorOwnerActs;
  availability(): Promise<ConnectorAvailability> | ConnectorAvailability;
}

const CONNECTOR_USE: CapabilityDemand = { capability: 'pairing', axis: 'use' };
/** Approving: the `configure` axis, so a device the operator narrowed to `pairing.use` cannot hand out a connector. */
const CONNECTOR_CONFIGURE: CapabilityDemand = { capability: 'pairing', axis: 'configure' };
/** Denying and revoking only take away; the same declaration device revocation makes. */
const CONNECTOR_NARROWING: CapabilityDemand = { ...CONNECTOR_USE, narrowing: true };

const REFUSAL_STATUS: Readonly<Record<ConnectorActRefusal['code'], number>> = {
  not_found: 404,
  expired: 410,
  already_decided: 409,
};
const REFUSAL_CODE: Readonly<Record<ConnectorActRefusal['code'], string>> = {
  not_found: CONNECTOR_REFUSAL_CODES.notFound,
  expired: CONNECTOR_REFUSAL_CODES.expired,
  already_decided: CONNECTOR_REFUSAL_CODES.alreadyDecided,
};

/** An act's refusal, in the daemon's own words, with a status and a code a client branches on. */
function refused(result: Exclude<ConnectorActResult<unknown>, { ok: true }>): ApiResponse {
  return errorResponse(REFUSAL_STATUS[result.code], result.message, REFUSAL_CODE[result.code]);
}

/** The act could not run because the connector is off: `409` and the reason, a plain sentence. */
function disabled(availability: Extract<ConnectorAvailability, { enabled: false }>): ApiResponse {
  return errorResponse(409, availability.disabledReason, CONNECTOR_REFUSAL_CODES.disabled);
}

/**
 * Claims the passkey proof approving needs, atomically. `undefined` means go on: the machine's own caller is
 * ungoverned and needs none. A governed caller without a fresh `approve-connector` proof is told which act to confirm.
 */
function claimApproval(context: RouteContext): ApiResponse | undefined {
  if (context.governance?.governed !== true) return undefined;
  if (context.claimFreshStepUp?.(STEP_UP_ACTS.approveConnector) === true) return undefined;
  return jsonResponse(
    {
      error: 'approving a Claude connector needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...CONNECTOR_CONFIGURE, act: STEP_UP_ACTS.approveConnector },
    } satisfies StepUpRequiredBody,
    403,
  );
}

const notFoundRequest = (): ApiResponse =>
  errorResponse(404, 'there is no such sign-in waiting', CONNECTOR_REFUSAL_CODES.notFound);

export function connectorRoutes(subsystem: ConnectorSubsystem): readonly ApiRoute[] {
  const { acts } = subsystem;
  return [
    {
      method: 'GET',
      path: '/v1/connector',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_USE,
      noStore: true,
      handle: async () => {
        const availability = await subsystem.availability();
        // Off: nothing to list, and no call into acts that may not exist. The sentence says why and what to do.
        const status = availability.enabled
          ? {
              enabled: true,
              publicUrl: availability.publicUrl,
              mcpUrl: availability.mcpUrl,
              pending: [...(await acts.pending())],
              grants: [...(await acts.grants())],
            }
          : { enabled: false, disabledReason: availability.disabledReason, pending: [], grants: [] };
        return jsonResponse(ConnectorStatusSchema.parse(status));
      },
    },
    {
      // `:id` is the public id or the match code; the daemon's act decides which.
      method: 'POST',
      path: '/v1/connector/requests/:id/approve',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_CONFIGURE,
      noStore: true,
      handle: async context => {
        await parseOptionalBody(context.request, ConnectorActRequestSchema);
        const ref = ConnectorRequestRefSchema.safeParse(decodeParameter(context.params.get('id') ?? ''));
        if (!ref.success) return notFoundRequest();
        const availability = await subsystem.availability();
        if (!availability.enabled) return disabled(availability);
        const missing = claimApproval(context);
        if (missing !== undefined) return missing;
        const result = await acts.approve(ref.data, context.actor ?? 'unknown');
        return result.ok ? jsonResponse(ConnectorGrantViewSchema.parse(result.value)) : refused(result);
      },
    },
    {
      method: 'POST',
      path: '/v1/connector/requests/:id/deny',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_NARROWING,
      noStore: true,
      handle: async context => {
        await parseOptionalBody(context.request, ConnectorActRequestSchema);
        const ref = ConnectorRequestRefSchema.safeParse(decodeParameter(context.params.get('id') ?? ''));
        if (!ref.success) return notFoundRequest();
        const availability = await subsystem.availability();
        if (!availability.enabled) return disabled(availability);
        const result = await acts.deny(ref.data, context.actor ?? 'unknown');
        return result.ok ? jsonResponse(ConnectorPendingViewSchema.parse(result.value)) : refused(result);
      },
    },
    {
      method: 'POST',
      path: '/v1/connector/grants/:id/revoke',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_NARROWING,
      noStore: true,
      handle: async context => {
        await parseOptionalBody(context.request, ConnectorActRequestSchema);
        const grantId = ConnectorGrantIdSchema.safeParse(decodeParameter(context.params.get('id') ?? ''));
        if (!grantId.success) return errorResponse(404, 'there is no such grant', CONNECTOR_REFUSAL_CODES.notFound);
        const availability = await subsystem.availability();
        if (!availability.enabled) return disabled(availability);
        const result = await acts.revoke(grantId.data, context.actor ?? 'unknown');
        return result.ok ? jsonResponse(ConnectorGrantViewSchema.parse(result.value)) : refused(result);
      },
    },
  ];
}
