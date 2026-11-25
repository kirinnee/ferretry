import { type ApiRequest, type ApiResponse, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import type { ConnectorService } from '../lib/service.ts';

/** What an unrouted path answers (`unknown_route`), so a connector that is off or not offered here cannot be told from no connector at all. */
function notServed(request: Pick<ApiRequest, 'method' | 'path'>): ApiResponse {
  const { method, path } = request;
  return jsonResponse({ error: `no route ${method} ${path}`, code: 'unknown_route', method, path }, 404);
}

/**
 * THE DOOR'S ROUTES (docs/mcp-connector.md "Where it listens"): the OAuth authorization server and `/mcp`.
 *
 * Every route does the same two things in the same order, and nothing else: it asks whether the connector serves THIS
 * arrival right now (on, with an address, and the right door for whose address it is — a descriptor cannot carry that
 * function), and then offers the request to the connector's handlers, which read their own bearer and nothing the kernel
 * knows about a caller. A request nobody serves is the 404 an unrouted path gets, whatever its path or method.
 */
export function doorRoute(service: ConnectorService): (call: CallContext) => Promise<ApiResponse> {
  return async ({ request }) => {
    if (!service.serving(request)) return notServed(request);
    for (const handler of service.handlers) {
      const answer = await handler.handle(request);
      if (answer !== undefined) return answer;
    }
    return notServed(request);
  };
}
