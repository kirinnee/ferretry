import type { ApiRequest, ApiResponse } from '@ferretry/kernel/contract';
import { unauthorizedResponse } from '../oauth/discovery.ts';
import type { ConnectorAccessVerifier, ConnectorEndpoints, ConnectorHttpHandler } from '../ports.ts';

const JSON_HEADERS: readonly [string, string][] = [
  ['content-type', 'application/json'],
  ['cache-control', 'no-store'],
];

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  extra: readonly [string, string][] = [],
): ApiResponse {
  return {
    status,
    headers: new Map([...JSON_HEADERS, ...extra]),
    body: JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  };
}

/**
 * `/mcp` BEFORE the tools exist: it already answers exactly what the endpoint will for everything that does not reach a
 * tool — a method other than POST is `405 Allow: POST`, no bearer is `401` with the resource-metadata pointer, a bearer
 * that is not live is `401 invalid_token` — so a client can finish its whole OAuth sign-in against this daemon. A live
 * bearer is told plainly that the tools are not served yet (`501`); it is never answered as if a tool had run. The MCP
 * unit replaces this handler and nothing else.
 */
export class ConnectorMcpStub implements ConnectorHttpHandler {
  constructor(
    private readonly verifier: ConnectorAccessVerifier,
    private readonly endpoints: ConnectorEndpoints,
  ) {}

  async handle(request: ApiRequest): Promise<ApiResponse | undefined> {
    if (request.path !== '/mcp') return undefined;
    if (request.method !== 'POST')
      return jsonRpcError(405, -32000, 'Method not allowed: this server answers POST only.', [['allow', 'POST']]);
    const header = request.headers.get('authorization');
    const match = header === undefined ? null : /^Bearer[ \t]+([^\s]+)$/iu.exec(header);
    const access = match?.[1] === undefined ? undefined : await this.verifier.verify(match[1]);
    if (access === undefined) return unauthorizedResponse(this.endpoints, { tokenPresented: header !== undefined });
    return jsonRpcError(501, -32000, 'The Claude tools are not served by this Ferretry yet.');
  }
}
