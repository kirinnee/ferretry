import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type PlainApiResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  McpCheckRequestSchema,
  McpOAuthCompleteRequestSchema,
  McpOAuthCompletionSchema,
  McpOAuthConnectionListSchema,
  McpOAuthFlowCancelledSchema,
  McpOAuthFlowSchema,
  McpOAuthSignedOutSchema,
  McpOAuthStartRequestSchema,
  type McpCheckResult,
  type McpInventory,
  type McpOAuthCompletion,
  type McpOAuthConnection,
  type McpOAuthFlow,
  type McpOAuthFlowCancelled,
  type McpOAuthSignedOut,
  type McpOAuthStartRequest,
  type McpOAuthCompleteRequest,
  type SessionMcpAdded,
  type SessionMcpAddRequest,
  SessionMcpAddRequestSchema,
  type SessionMcpListing,
  type SessionMcpPreview,
  type SessionMcpPreviewRequest,
  SessionMcpPreviewRequestSchema,
} from '../contract/index.ts';
import { parseBody, parseOptionalBody } from './lib/body.ts';
import { McpInventoryRefusal } from './lib/inventory/service.ts';
import { McpOAuthRefusal } from './lib/oauth/service.ts';
import { SessionMcpRefusal } from './lib/session/service.ts';

/** The inventory and the check (today's `mcp-inventory.ts`). */
export interface McpInventorySubsystem {
  machine(): Promise<McpInventory>;
  ferret(ferretId: string): Promise<McpInventory>;
  check(id: string, ferretId?: string): Promise<McpCheckResult>;
}

/** The five sign-in acts (today's `mcp-oauth.ts`). */
export interface McpOAuthSubsystem {
  connections(): Promise<readonly McpOAuthConnection[]>;
  start(component: string, request: McpOAuthStartRequest): Promise<McpOAuthFlow>;
  complete(flowId: string, request: McpOAuthCompleteRequest): Promise<McpOAuthCompletion>;
  cancel(flowId: string): Promise<McpOAuthFlowCancelled>;
  signOut(component: string): Promise<McpOAuthSignedOut>;
}

/** Adding a server for one ferret (today's `session-mcp.ts`). */
export interface SessionMcpSubsystem {
  list(ferretId: string): Promise<SessionMcpListing>;
  previewProject(ferretId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview>;
  addProject(ferretId: string, request: SessionMcpAddRequest): Promise<SessionMcpAdded>;
  previewLogin(ferretId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview>;
  addLogin(ferretId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpAdded>;
}

function ferretId(call: CallContext): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
}

function parameter(call: CallContext, name: string, what: string): string {
  const value = decodeParameter(call.params.get(name) ?? '') ?? '';
  if (value === '') throw new ApiError(400, `the ${what} in the path is not usable`, 'bad_request');
  return value;
}

/** Restates every refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof McpInventoryRefusal) throw new ApiError(error.status, error.message, error.code);
  if (error instanceof SessionMcpRefusal) throw new ApiError(error.status, error.message, error.code);
  if (error instanceof McpOAuthRefusal) {
    const missing = error.code === 'mcp_auth_unknown_component' || error.code === 'mcp_auth_unknown_flow';
    throw new ApiError(missing ? 404 : 409, error.message, error.code);
  }
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<PlainApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

export function inventoryRoutes(subsystem: McpInventorySubsystem): {
  readonly 'GET /v1/mcp': RouteHandler;
  readonly 'POST /v1/mcp/check': RouteHandler;
  readonly 'GET /v1/ferrets/:ferretId/mcp/servers': RouteHandler;
} {
  return {
    'GET /v1/mcp': async () => await answer(() => subsystem.machine()),
    'POST /v1/mcp/check': async call => {
      const request = await parseBody(call.request, McpCheckRequestSchema);
      return await answer(() => subsystem.check(request.id, request.sessionId));
    },
    'GET /v1/ferrets/:ferretId/mcp/servers': async call => {
      const id = ferretId(call);
      return await answer(() => subsystem.ferret(id));
    },
  };
}

export function oauthRoutes(subsystem: McpOAuthSubsystem): {
  readonly 'GET /v1/mcp/auth': RouteHandler;
  readonly 'POST /v1/mcp/auth/:component': RouteHandler;
  readonly 'DELETE /v1/mcp/auth/:component': RouteHandler;
  readonly 'POST /v1/mcp/auth/flows/:flowId': RouteHandler;
  readonly 'DELETE /v1/mcp/auth/flows/:flowId': RouteHandler;
} {
  return {
    'GET /v1/mcp/auth': async () =>
      await answer(async () => McpOAuthConnectionListSchema.parse({ connections: await subsystem.connections() })),
    'POST /v1/mcp/auth/:component': async call => {
      const component = parameter(call, 'component', 'server name');
      const request = await parseOptionalBody(call.request, McpOAuthStartRequestSchema);
      return await answer(async () => McpOAuthFlowSchema.parse(await subsystem.start(component, request)));
    },
    'DELETE /v1/mcp/auth/:component': async call => {
      const component = parameter(call, 'component', 'server name');
      return await answer(async () => McpOAuthSignedOutSchema.parse(await subsystem.signOut(component)));
    },
    'POST /v1/mcp/auth/flows/:flowId': async call => {
      const flow = parameter(call, 'flowId', 'sign-in id');
      const request = await parseBody(call.request, McpOAuthCompleteRequestSchema);
      return await answer(async () => McpOAuthCompletionSchema.parse(await subsystem.complete(flow, request)));
    },
    'DELETE /v1/mcp/auth/flows/:flowId': async call => {
      const flow = parameter(call, 'flowId', 'sign-in id');
      return await answer(async () => McpOAuthFlowCancelledSchema.parse(await subsystem.cancel(flow)));
    },
  };
}

export function sessionRoutes(subsystem: SessionMcpSubsystem): {
  readonly 'POST /v1/ferrets/:ferretId/mcp/project/preview': RouteHandler;
  readonly 'POST /v1/ferrets/:ferretId/mcp/login/preview': RouteHandler;
  readonly 'POST /v1/ferrets/:ferretId/mcp/project': RouteHandler;
  readonly 'POST /v1/ferrets/:ferretId/mcp/login': RouteHandler;
  readonly 'GET /v1/ferrets/:ferretId/mcp': RouteHandler;
} {
  return {
    'POST /v1/ferrets/:ferretId/mcp/project/preview': async call => {
      const id = ferretId(call);
      const request = await parseBody(call.request, SessionMcpPreviewRequestSchema);
      return await answer(() => subsystem.previewProject(id, request));
    },
    'POST /v1/ferrets/:ferretId/mcp/login/preview': async call => {
      const id = ferretId(call);
      const request = await parseBody(call.request, SessionMcpPreviewRequestSchema);
      return await answer(() => subsystem.previewLogin(id, request));
    },
    'POST /v1/ferrets/:ferretId/mcp/project': async call => {
      const id = ferretId(call);
      const request = await parseBody(call.request, SessionMcpAddRequestSchema);
      return await answer(() => subsystem.addProject(id, request));
    },
    'POST /v1/ferrets/:ferretId/mcp/login': async call => {
      const id = ferretId(call);
      const request = await parseBody(call.request, SessionMcpPreviewRequestSchema);
      return await answer(() => subsystem.addLogin(id, request));
    },
    'GET /v1/ferrets/:ferretId/mcp': async call => {
      const id = ferretId(call);
      return await answer(() => subsystem.list(id));
    },
  };
}
