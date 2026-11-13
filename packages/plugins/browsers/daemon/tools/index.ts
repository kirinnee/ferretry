import { DEVICE_ACTOR_PREFIX, ferretOf } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import { SurfaceControlRequestSchema } from '../../contract/index.ts';
import { PageHeld } from '../holds/index.ts';
import { parseBody, parseValue } from '../pages/body.ts';
import { sessionIdOf } from '../pages/routes.ts';
import type { SurfaceOpener } from '../../contract/wire/surface.ts';
import type { SurfaceController } from '../../contract/wire/control.ts';
import { type BrowserToolAnswer, BrowserToolError, type BrowserTools } from './service.ts';
import type { ToolCaller } from './types.ts';
import { type BrowserToolCall, BrowserToolCallSchema, type BrowserToolName } from './wire.ts';

/** The MCP name of each browser tool (`browser_navigate`) and the call it carries (`browser.navigate`). */
const toolOf = (name: string): BrowserToolName => `browser.${name.slice('browser_'.length)}` as BrowserToolName;

/** Who the call is, from the kernel-stamped standing: a ferret's own call, or a person's about one ferret. */
function callerOf(call: CallContext, sessionId?: string): ToolCaller {
  const ferret = ferretOf(call);
  if (ferret !== undefined) return { kind: 'agent', sessionId: ferret };
  if (sessionId === undefined)
    throw new ApiError(
      400,
      'A person calls the browser tools on one ferret: use the ferret’s browser tools route.',
      'bad_request',
    );
  const actor = call.actor ?? '';
  const openedBy: SurfaceOpener = actor.startsWith(DEVICE_ACTOR_PREFIX)
    ? { by: 'human', deviceId: actor.slice(DEVICE_ACTOR_PREFIX.length) }
    : { by: 'local' };
  return { kind: 'person', sessionId, openedBy };
}

/** A refusal's status, as today's agent-tools route answered it. */
const STATUS: Readonly<Record<BrowserToolError['code'], number>> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  taken_over: 409,
  capacity: 409,
  unavailable: 503,
  upstream_failed: 502,
};

/** An answer as MCP text: the sentence, then what was read. A picture rides in `data`, base64. */
function toolResult(answer: BrowserToolAnswer): ToolResult {
  const text = answer.output === undefined ? answer.summary : `${answer.summary}\n\n${answer.output}`;
  const data: Record<string, unknown> = {};
  if (answer.surfaces !== undefined) data.surfaces = answer.surfaces;
  if (answer.matched !== undefined) data.matched = answer.matched;
  if (answer.picture !== undefined && answer.picture.bytes.byteLength > 0)
    data.picture = { mime: answer.picture.mime, base64: Buffer.from(answer.picture.bytes).toString('base64') };
  return Object.keys(data).length === 0 ? { text } : { text, data: data as never };
}

/**
 * One tool handler: parse `{ tool, ...input }`, call, answer; a refusal (a domain refusal, or a hold) is an MCP error
 * with its sentence. Every failure has already passed {@link BrowserTools.call}'s hold answer and redactor (I120).
 */
export function toolHandler(tools: BrowserTools, name: string): ToolHandler {
  return async (call, input) => {
    const parsed = parseValue(
      BrowserToolCallSchema,
      { ...(input as object), tool: toolOf(name) },
      'arguments',
    ) as BrowserToolCall;
    try {
      return toolResult(await tools.call(callerOf(call), parsed));
    } catch (error) {
      if (error instanceof BrowserToolError || error instanceof PageHeld) return { text: error.message, isError: true };
      throw error;
    }
  };
}

/** The browser tools this half answers (part a); `browser_type`, `browser_fill_form`, `browser_request_input` and
 *  `browser_ask_owner` are registered by the `page` target (`../target/index.ts`). */
export const PART_A_TOOLS = [
  'browser_list',
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_read',
  'browser_screenshot',
  'browser_dialog',
  'browser_tabs',
  'browser_wait_for',
  'browser_console',
  'browser_network',
  'browser_emulate',
  'browser_upload',
  'browser_download',
  'browser_pdf',
  'browser_hover',
  'browser_drag',
  'browser_mouse',
  'browser_press',
  'browser_scroll',
  'browser_select',
  'browser_check',
  'browser_highlight',
  'browser_eval',
  'browser_close',
] as const;

export function toolHandlers(tools: BrowserTools): { readonly [K in (typeof PART_A_TOOLS)[number]]: ToolHandler } {
  return Object.fromEntries(PART_A_TOOLS.map(name => [name, toolHandler(tools, name)])) as never;
}

/** Who a person's control act is by: their device, or the box. */
function controllerOf(call: CallContext): SurfaceController {
  const actor = call.actor ?? '';
  return (
    actor.startsWith(DEVICE_ACTOR_PREFIX)
      ? { by: 'human', deviceId: actor.slice(DEVICE_ACTOR_PREFIX.length) }
      : { by: 'local' }
  ) as SurfaceController;
}

/** A route's refusal as its status; the message already passed the hold answer and the redactor (I120). */
export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BrowserToolError) throw new ApiError(STATUS[error.code], error.message, error.code);
    if (error instanceof PageHeld) throw new ApiError(409, error.message, error.code);
    throw error;
  }
}

/** The surface control routes and the person's tool route (today's `agent-tools.ts` browser surface routes). */
export function controlRoutes(tools: BrowserTools) {
  return {
    'GET /v1/ferrets/:ferretId/surfaces/browser/control': (async call =>
      jsonResponse(await refusing(async () => await tools.controlView(sessionIdOf(call))))) satisfies RouteHandler,
    'POST /v1/ferrets/:ferretId/surfaces/browser/control': (async call => {
      const request = await parseBody(call.request, SurfaceControlRequestSchema);
      return jsonResponse(
        await refusing(async () => await tools.control(sessionIdOf(call), request, controllerOf(call))),
      );
    }) satisfies RouteHandler,
    'POST /v1/ferrets/:ferretId/surfaces/browser/tools': (async call => {
      const parsed = await parseBody(call.request, BrowserToolCallSchema);
      const answer = await refusing(async () => await tools.call(callerOf(call, sessionIdOf(call)), parsed));
      return jsonResponse(toolResult(answer));
    }) satisfies RouteHandler,
  } as const;
}
