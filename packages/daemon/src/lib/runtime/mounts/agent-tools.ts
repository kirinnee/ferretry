import {
  type AgentToolCall,
  AgentToolCallSchema,
  type AgentToolResult,
  type SurfaceController,
  SurfaceControlRequestSchema,
  type SurfaceKind,
} from '@ferretry/protocol';
import { AgentToolError, type AgentToolService } from '../../agent-tools/service.ts';
import type { AgentIdentityResolver, AgentToolCaller } from '../../agent-tools/types.ts';
import { isHumanAdminActor } from '../../api/actor.ts';
import {
  bearerToken,
  isSessionCredential,
  type SessionCredentialDirectory,
  secretsMatch,
} from '../../api/authentication.ts';
import { parseBody } from '../../api/body.ts';
import { grantRefusalCode } from '../../api/capability.ts';
import { SESSION_ID_HEADER } from '../../api/dispatcher.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { auditActorOf } from '../../audit/policy.ts';
import type { AuditSink } from '../../audit/types.ts';
import { decideTerminalOpener } from '../../terminal/ownership.ts';

/**
 * THE AGENT TOOLS, OVER HTTP — terminals and browser pages driven by name.
 *
 * ## THE AGENT'S ROUTE CARRIES NO HOST AUTHORITY AND NAMES NO SESSION
 *
 * `POST /v1/agent/tools` is authenticated by the session credential alone — the one the daemon minted
 * into that session's own environment and keeps only a hash of — and NOT by the host's admin token,
 * which it neither needs nor reads. So the tools server an agent runs holds exactly its session's
 * authority and nothing more. It is served only over a privileged loopback carrier (`privilegedOnly`):
 * a paired device, or anything arriving through the relay, is refused before the handler runs.
 *
 * There is no session id in its path or its body (the call schema is strict, so a `sessionId` field is
 * refused), and the session is the credential's: `x-ferretry-session-id` may only agree with it — one
 * naming another session is `401 session_mismatch`. So the only way to act as a session here is to hold
 * that session's secret. A refused credential or body is audited too, so guessing leaves a trace.
 *
 * The credential arrives as `Authorization: Bearer fys_…` (the ferret session credential,
 * docs/agent-tools.md) or on `x-fy-session-capability`, where a pane started before the `fys_` prefix
 * still presents its unprefixed value until its next launch. Both are the one lookup.
 *
 * ## A PERSON'S ROUTES NAME THE SESSION, AND REFUSE AN AGENT
 *
 * Everything under `/v1/sessions/:sessionId/surfaces` is a person's — the CLI and the app — governed by
 * the `terminal` and `browser` grants like every other surface route. An agent that identifies itself
 * (`peer:` or `warden:`) is refused there and pointed at its own route, which is the one that holds it
 * to its own surfaces, the machine's switches and a person's takeover.
 *
 * ## WHAT THIS DOES NOT STOP — DECLARED
 *
 * An agent runs as the same user as this daemon and can read the admin token from the state home.
 * Such an agent can call a person's route without identifying itself. That is the shared-token
 * boundary every peer route already states (`isHumanAdminActor`): for honest clients, not a sandbox.
 */

/**
 * Where an agent presents its own session credential: never a body field, never argv. A wire contract
 * with `packages/cli/src/lib/agent-tools/client.ts`. It is not in the protocol package on purpose —
 * no browser ever sends it, and that package is what a browser bundle is built from.
 */
export const AGENT_SESSION_CAPABILITY_HEADER = 'x-fy-session-capability';

/** The longest route the security log is told, within its one-line text bound. */
const AUDITED_ROUTE_LENGTH = 160;

/**
 * The ferret session credential as the authorization boundary asks about it.
 *
 * The SAME resolver this route uses, so a value names one session whichever door it arrives at — the
 * bearer on any route, or `x-fy-session-capability` here — and a refusal is written to the security log
 * naming the session the credential named, never the credential.
 */
export function sessionCredentialDirectory(
  identities: AgentIdentityResolver,
  audit: AuditSink,
): SessionCredentialDirectory {
  return {
    resolve: async capability => {
      const identity = await identities.resolve(capability);
      return identity === undefined ? undefined : { sessionId: identity.sessionId };
    },
    refused: async refusal => {
      await audit.record({
        event: 'session.credential-refused',
        actor: { kind: 'host' },
        subject: refusal.sessionId,
        outcome: 'refused',
        detail: { by: 'agent', reason: refusal.reason, route: refusal.route.slice(0, AUDITED_ROUTE_LENGTH) },
      });
    },
  };
}

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

/** The agent behind a request, from its session credential and from nothing else. Refusals are audited. */
async function agentOf(
  service: AgentToolService,
  identities: AgentIdentityResolver,
  context: RouteContext,
): Promise<AgentToolCaller> {
  // Only a session-shaped bearer is one: this route has always ignored any other `Authorization` value.
  const bearer = bearerToken(headerValue(context.request, 'authorization'));
  const presented = isSessionCredential(bearer) ? bearer : undefined;
  const header = headerValue(context.request, AGENT_SESSION_CAPABILITY_HEADER)?.trim() ?? '';
  if (presented !== undefined && header !== '' && !secretsMatch(presented, header)) {
    await service.refusedCaller('two different session credentials');
    throw new ApiError(
      401,
      `this request carries two different session credentials, as a bearer and in ${AGENT_SESSION_CAPABILITY_HEADER}; send one`,
      'unauthorized',
    );
  }
  const capability = presented ?? header;
  if (capability === '') {
    await service.refusedCaller('no session credential');
    throw new ApiError(
      401,
      'agent tools need the session credential Ferretry gives each agent session (FY_SESSION_BOARD_CAPABILITY); run this from inside an agent session',
      'missing_capability',
    );
  }
  const identity = await identities.resolve(capability);
  if (identity === undefined) {
    await service.refusedCaller('unknown session credential');
    throw new ApiError(403, 'the session credential names no running session on this machine', 'forbidden');
  }
  // The credential says which session this is. A header can only agree; one that names another session
  // is an attribution the credential does not back, so it is refused rather than quietly overruled.
  const claimed = headerValue(context.request, SESSION_ID_HEADER)?.trim() ?? '';
  if (claimed !== '' && claimed !== identity.sessionId) {
    await service.refusedCaller('session id header names another session');
    throw new ApiError(
      401,
      `this session credential names its own session, and ${SESSION_ID_HEADER} names a different one; drop the header — the daemon reads who you are from the credential`,
      'session_mismatch',
    );
  }
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

/** Who a person taking a surface over or handing it on is, as the record says. */
function controllerOf(context: RouteContext): SurfaceController {
  const credential = context.credential;
  return credential?.tokenClass === 'device' ? { by: 'human', deviceId: credential.deviceId } : { by: 'local' };
}

/** The kind a person's route must match; `input.wait` is about a request, so no per-kind route takes it. */
const kindOf = (call: AgentToolCall): SurfaceKind | undefined =>
  call.tool === 'input.wait' || call.tool === 'account.hint' || call.tool === 'account.propose'
    ? undefined
    : call.tool.startsWith('terminal.')
      ? 'terminal'
      : 'browser';

/** A hold taken since the service answered still wins, now and again as the dispatcher sends the body. */
function published(service: AgentToolService, result: AgentToolResult): ApiResponse {
  const spell = (): ApiResponse => {
    try {
      return jsonResponse(service.publish(result));
    } catch (error) {
      return answered(error);
    }
  };
  return { ...spell(), late: spell };
}

async function agentCall(
  service: AgentToolService,
  identities: AgentIdentityResolver,
  context: RouteContext,
): Promise<ApiResponse> {
  const caller = await agentOf(service, identities, context);
  const call = await parseBody(context.request, AgentToolCallSchema).catch(async (error: unknown) => {
    await service.refusedCaller('not a tool call');
    throw error;
  });
  return published(service, await service.call(caller, call).catch(answered));
}

/** The tools that move a file between a page and the session's folder. */
const FILE_TOOLS: ReadonlySet<AgentToolCall['tool']> = new Set(['browser.upload', 'browser.download', 'browser.pdf']);

/**
 * A file tool reaches the host's disk, so the route's `browser` grant is not enough: the caller needs the
 * `filesystem` grant on `use` as well. A paired phone granted the browser must not read or write the host's
 * folders through it. A caller the grants cannot be read for is refused rather than waved through.
 */
function refusedFileTool(context: RouteContext): ApiError | undefined {
  const governance = context.governance;
  if (governance === undefined)
    return new ApiError(403, 'this daemon cannot say whether this caller may use files', 'forbidden');
  const decision = governance.decide({ capability: 'filesystem', axis: 'use' });
  if (decision.allowed) return undefined;
  return new ApiError(
    403,
    'this device may not move files between the browser and this machine; that needs the filesystem permission',
    grantRefusalCode(decision.refusal),
  );
}

async function personCall(service: AgentToolService, kind: SurfaceKind, context: RouteContext): Promise<ApiResponse> {
  const caller = personOf(context);
  const call = await parseBody(context.request, AgentToolCallSchema);
  // A secure copy is an agent's (docs/secure-copy.md): a command copy runs a program on this machine, so no
  // person's surface route may carry one, whatever grant it was reached with. The owner uses `fy copy`.
  if (call.tool.startsWith('secure.'))
    throw new ApiError(400, `${call.tool} is an agent's tool, not one a person's surface route takes`, 'bad_request');
  if (kindOf(call) !== kind)
    throw new ApiError(400, `this route takes ${kind} tools; ${call.tool} is not one`, 'bad_request');
  if (FILE_TOOLS.has(call.tool)) {
    const refusal = refusedFileTool(context);
    if (refusal !== undefined) throw refusal;
  }
  return published(service, await service.call(caller, call).catch(answered));
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
 * subsystem uses, so none of them can shadow or be shadowed by `…/terminals/:terminalId`. Each person's
 * route is one kind's, so each is governed by that kind's grant — the control reads included.
 */
export function agentToolRoutes(service: AgentToolService, identities: AgentIdentityResolver): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/agent/tools',
      minimum: 'none',
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
      method: 'GET',
      path: '/v1/sessions/:sessionId/surfaces/terminals/control',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => jsonResponse(await service.controlView(sessionOf(context), 'terminal')),
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
      path: '/v1/sessions/:sessionId/surfaces/browser/control',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async context => jsonResponse(await service.controlView(sessionOf(context), 'browser')),
    },
  ];
}
