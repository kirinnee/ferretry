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
 * ## SWITCHING IT (`PUT /v1/connector`)
 *
 * `pairing.configure`, exactly as `PUT /v1/tunnel` is: a connector changes how OTHER programs reach this host, and
 * that is the subject `pairing` already governs. A governed caller therefore needs that grant AND the step-up every
 * `configure` demand takes — the app's passkey IS the owner's confirmation — while the host's own admin token over
 * loopback is ungoverned. Turning it ON reaches nothing by itself: every sign-in still needs its own `approve-connector`
 * passkey, and a connector holds no device, so it can never switch itself on or off (`caller: 'person'`). Off is the
 * default, and a config that names no `publicUrl` serves the connector over the built-in tunnel only.
 *
 * ## WHEN THE CONNECTOR IS OFF
 *
 * `GET` still answers — `enabled: false` and a sentence saying why and what to do — so `fy connector` and the app can
 * explain it, and still lists the grants that were given: ending access is never harder than giving it, so an owner who
 * switched the connector off to contain one can revoke it without switching it back on. Approve and deny answer
 * `409 connector_disabled` with a plain sentence and never touch the acts; revoke works off or on.
 */
import {
  CONNECTOR_REFUSAL_CODES,
  ConnectorActRequestSchema,
  ConnectorChangeSchema,
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
  parseBody,
  parseOptionalBody,
  type RouteContext,
} from '../../api/index.ts';
import type { ConnectorActRefusal, ConnectorActResult, ConnectorOwnerActs } from '../../connector/ports.ts';

/**
 * Whether the connector is on, and where. Read fresh on every request, because the owner may switch it on and the
 * daemon pick that up while the routes are mounted.
 */
export type ConnectorAvailability =
  | {
      readonly enabled: true;
      readonly publicUrl: string;
      readonly mcpUrl: string;
      /** Whose address it is: the operator's `connector.publicUrl`, or this machine's built-in tunnel hostname. */
      readonly source: 'configured' | 'tunnel';
    }
  | {
      readonly enabled: false;
      readonly disabledReason: string;
      /** Switched on but not reachable yet (waiting for the tunnel, or it could not start) — as opposed to off. */
      readonly switchedOn: boolean;
    };

/** The answer of a switch: done, or a sentence saying why not. Nothing is written when it is a refusal. */
export type ConnectorChangeResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface ConnectorSubsystem {
  readonly acts: ConnectorOwnerActs;
  availability(): Promise<ConnectorAvailability> | ConnectorAvailability;
  /** Switches the connector on or off live, writing the same `connector.enabled` the host edit writes. */
  change(enabled: boolean): Promise<ConnectorChangeResult>;
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
  /** The status document, read fresh. Off or waiting: nothing to list, and no call into acts that may not exist. */
  const statusOf = async () => {
    const availability = await subsystem.availability();
    return ConnectorStatusSchema.parse(
      availability.enabled
        ? {
            enabled: true,
            switchedOn: true,
            publicUrlSource: availability.source,
            publicUrl: availability.publicUrl,
            mcpUrl: availability.mcpUrl,
            pending: [...(await acts.pending())],
            grants: [...(await acts.grants())],
          }
        : {
            enabled: false,
            switchedOn: availability.switchedOn,
            disabledReason: availability.disabledReason,
            pending: [],
            // Granted access is listed — and revocable — whether or not the connector is reachable: an owner who
            // switched it off to contain a grant must be able to end that grant without switching it back on.
            grants: [...(await acts.grants().catch(() => []))],
          },
    );
  };
  return [
    {
      method: 'GET',
      path: '/v1/connector',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_USE,
      noStore: true,
      handle: async () => jsonResponse(await statusOf()),
    },
    {
      method: 'PUT',
      path: '/v1/connector',
      minimum: 'operator',
      caller: 'person',
      capability: CONNECTOR_CONFIGURE,
      noStore: true,
      handle: async context => {
        const change = await parseBody(context.request, ConnectorChangeSchema);
        const result = await subsystem.change(change.enabled);
        if (!result.ok) return errorResponse(409, result.message, CONNECTOR_REFUSAL_CODES.cannotSwitch);
        return jsonResponse(await statusOf());
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
        // No availability check: ending access is never harder than giving it, off or on.
        const result = await acts.revoke(grantId.data, context.actor ?? 'unknown');
        return result.ok ? jsonResponse(ConnectorGrantViewSchema.parse(result.value)) : refused(result);
      },
    },
  ];
}
