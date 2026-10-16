import {
  AgentToolCallSchema,
  type AgentToolCall,
  type SurfaceController,
  SurfaceControlRequestSchema,
  type SurfaceKind,
} from '@ferretry/protocol';
import { isHumanAdminActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { AgentToolError, type AgentToolService } from '../../agent-tools/service.ts';
import type { AgentIdentityResolver, AgentToolCaller } from '../../agent-tools/types.ts';
import { auditActorOf } from '../../audit/policy.ts';
import { decideTerminalOpener } from '../../terminal/ownership.ts';

/**
 * THE AGENT TOOLS, OVER HTTP — terminals and browser pages driven by name.
 *
 * ## THE AGENT'S ROUTE NAMES NO SESSION
 *
 * `POST /v1/agent/tools` derives its session from the session credential the caller presents, which
 * the daemon minted into that session's own environment at launch and keeps only a hash of. There is
 * no session id in its path, its body (the call schema is strict, so a `sessionId` field is refused)
 * or any header it reads, so the one way to act as a session here is to hold that session's secret —
 * and what it then reaches is that session's surfaces, on this machine, and nothing else.
 *
 * It is served to the host's OWN admin token arriving over loopback (`admin-token`, `privilegedOnly`),
 * and to nothing else: a paired device, a warden, or anything reaching the daemon through the relay
 * is refused before the handler runs.
 *
 * ## A PERSON'S ROUTES NAME THE SESSION, AND REFUSE AN AGENT
 *
 * `…/surfaces/terminals/tools` and `…/surfaces/browser/tools` are what `fy terminal` and `fy browser` use from a
 * person's shell, governed by the `terminal` and `browser` grants like every other surface route. An
 * agent that identifies itself (`peer:` or `warden:`) is refused there and told to use its own route,
 * so the honest path for an agent is always the one that checks takeover and the machine's switches.
 *
 * ## WHAT THIS DOES NOT STOP — DECLARED
 *
 * An agent runs as the same user as this daemon and can read the admin token from the state home,
 * as every in-pane `fy` command does. Such an agent can call a person's route without identifying
 * itself, and so act on a surface past a takeover. That is the shared-token boundary every peer route
 * already states (`isHumanAdminActor`): an operational boundary for honest clients, not a sandbox.
 * The agent route is what holds an agent to its own session; the shell an agent is given is not a
 * containment.
 */

/**
 * Where an agent presents its own session credential: never a body field, never argv. A wire contract
 * with `packages/cli/src/lib/agent-tools/client.ts`. It is not in the protocol package on purpose —
 * no browser ever sends it, and that package is what a browser bundle is built from.
 */
export const AGENT_SESSION_CAPABILITY_HEADER = 'x-fy-session-capability';

/** HTTP status for each refusal. A takeover is a 409: the call was fine and the surface is busy. */
const STATUS: Readonly<Record<AgentToolError['code'], number>> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  taken_over: 409,
  capacity: 409,
  unavailable: 503,
  upstream_failed: 502,
};

function answered(error: unknown): never {
  if (error instanceof AgentToolError) throw new ApiError(STATUS[error.code], error.message, error.code);
  throw error;
}

function sessionOf(context: RouteContext): string {
  const id = context.params.get('sessionId') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    throw new ApiError(400, 'the session id in the path is not usable', 'bad_request');
  return id;
}

/** The agent behind a request, from its session credential and from nothing else. */
async function agentOf(identities: AgentIdentityResolver, context: RouteContext): Promise<AgentToolCaller> {
  const capability = headerValue(context.request, AGENT_SESSION_CAPABILITY_HEADER)?.trim() ?? '';
  if (capability === '')
    throw new ApiError(
      401,
      'agent tools need the session credential Ferretry gives each agent session (FY_SESSION_BOARD_CAPABILITY); run this from inside an agent session',
      'missing_capability',
    );
  const identity = await identities.resolve(capability);
  if (identity === undefined)
    throw new ApiError(403, 'the session credential names no running session on this machine', 'forbidden');
  return {
    kind: 'agent',
    sessionId: identity.sessionId,
    ...(identity.name === undefined ? {} : { name: identity.name }),
  };
}

/**
 * A person, acting on a session they named. A caller that says it is an agent is sent to its own
 * route instead — see the module comment for why that matters.
 */
function personOf(context: RouteContext): AgentToolCaller & { readonly kind: 'person' } {
  const credential = context.credential;
  const human = credential?.tokenClass === 'device' || isHumanAdminActor(context.actor);
  if (!human)
    throw new ApiError(
      403,
      'an agent drives terminals and browsers with its own session credential (POST /v1/agent/tools), not by naming a session',
      'forbidden',
    );
  const opener = decideTerminalOpener(credential, undefined);
  return {
    kind: 'person',
    sessionId: sessionOf(context),
    actor: auditActorOf(credential, undefined),
    ...(opener.outcome === 'attributed' ? { openedBy: opener.openedBy } : {}),
  };
}

/** Who a person taking a surface over is, as the takeover records it. */
function controllerOf(context: RouteContext): SurfaceController {
  const credential = context.credential;
  return credential?.tokenClass === 'device' ? { by: 'human', deviceId: credential.deviceId } : { by: 'local' };
}

const kindOf = (call: AgentToolCall): SurfaceKind => (call.tool.startsWith('terminal.') ? 'terminal' : 'browser');

async function agentCall(
  service: AgentToolService,
  identities: AgentIdentityResolver,
  context: RouteContext,
): Promise<ApiResponse> {
  const caller = await agentOf(identities, context);
  const call = await parseBody(context.request, AgentToolCallSchema);
  return jsonResponse(await service.call(caller, call).catch(answered));
}

async function personCall(service: AgentToolService, kind: SurfaceKind, context: RouteContext): Promise<ApiResponse> {
  const caller = personOf(context);
  const call = await parseBody(context.request, AgentToolCallSchema);
  if (kindOf(call) !== kind)
    throw new ApiError(400, `this route takes ${kind} tools; ${call.tool} is not one`, 'bad_request');
  return jsonResponse(await service.call(caller, call).catch(answered));
}

async function control(service: AgentToolService, kind: SurfaceKind, context: RouteContext): Promise<ApiResponse> {
  const caller = personOf(context);
  const request = await parseBody(context.request, SurfaceControlRequestSchema);
  return jsonResponse(
    await service.control(caller.sessionId, kind, request, controllerOf(context), caller).catch(answered),
  );
}

/**
 * Every route but the agent's lives under `/v1/sessions/:sessionId/surfaces`, a segment no other
 * subsystem uses, so none of them can shadow or be shadowed by `…/terminals/:terminalId`.
 */
export function agentToolRoutes(service: AgentToolService, identities: AgentIdentityResolver): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/agent/tools',
      minimum: 'admin-token',
      privilegedOnly: true,
      noStore: true,
      handle: async context => await agentCall(service, identities, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/surfaces/terminals/tools',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await personCall(service, 'terminal', context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/surfaces/terminals/control',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await control(service, 'terminal', context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/surfaces/browser/tools',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async context => await personCall(service, 'browser', context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/surfaces/browser/control',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async context => await control(service, 'browser', context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/surfaces/control',
      minimum: 'operator',
      noStore: true,
      handle: async context => jsonResponse(service.controlView(sessionOf(context))),
    },
  ];
}
