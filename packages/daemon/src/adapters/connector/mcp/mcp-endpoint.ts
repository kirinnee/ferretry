import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type ApiRequest, type ApiResponse, BodyTooLargeError } from '../../../lib/api/http.ts';
import type {
  ConnectorAccess,
  ConnectorAccessVerifier,
  ConnectorApiDispatch,
  ConnectorHttpHandler,
} from '../../../lib/connector/ports.ts';
import { FleetGateway } from '../../../lib/connector/mcp/gateway.ts';
import { SlidingWindowLimiter } from '../../../lib/connector/mcp/rate-limit.ts';
import { CONNECTOR_TOOLS, type ConnectorToolbox, type ConnectorToolSpec } from '../../../lib/connector/mcp/tools.ts';

/** The one path this handler answers. */
export const MCP_PATH = '/mcp';
/** A tools/call body is a few kilobytes; a megabyte is already generous. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;
/** docs/mcp-connector.md "Rate limits": per grant, per minute. */
export const CALLS_PER_MINUTE = 60;
export const WRITE_CALLS_PER_MINUTE = 10;

export interface ConnectorMcpEndpointOptions {
  readonly verifier: ConnectorAccessVerifier;
  /** The OAuth part's 401 builder: `(tokenPresented) => 401 + WWW-Authenticate`. Injected so the parts stay apart. */
  readonly unauthorized: (tokenPresented: boolean) => ApiResponse;
  readonly dispatch: ConnectorApiDispatch;
  readonly toolbox: ConnectorToolbox;
  readonly now: () => number;
  /** A fresh logical request id for a send / start / restart (the daemon's retry contract). */
  readonly newRequestId: () => string;
  /** `Origin` values that may call `/mcp`. Default: none — a browser page on any origin is refused (DNS rebinding). */
  readonly allowedOrigins?: readonly string[];
  readonly serverVersion: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

function jsonRpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: new Map(Object.entries({ ...JSON_HEADERS, ...extra })),
    body: JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  };
}

/**
 * `POST /mcp` — MCP Streamable HTTP, STATELESS, JSON responses (docs/mcp-connector.md).
 *
 * ONE SERVER AND ONE TRANSPORT PER REQUEST (the SDK's stateless pattern): there is no session to hijack, no
 * stream to hold open and nothing to remember between calls, so a daemon restart or a second daemon loses
 * nothing. The server is built FOR the token's scopes — write tools are not even registered for a read-only
 * token, so `tools/list` never offers them.
 *
 * ORDER OF GATES, each before the next: path → method → Origin → bearer → body bound → JSON → rate limit → the
 * SDK. Auth failures never reach a tool.
 *
 * RATE LIMITING IS HTTP-LEVEL (`429` + `Retry-After`), as the contract says: a runaway loop is stopped before
 * it costs a server and a daemon call; `Retry-After` lets a well-behaved client back off, where a tool-level
 * error would only be read aloud as another sentence. Only `tools/call` counts — `initialize` and `tools/list`
 * are free.
 */
export class ConnectorMcpEndpoint implements ConnectorHttpHandler {
  readonly #limiter: SlidingWindowLimiter;
  readonly #specs = new Map<string, ConnectorToolSpec>(CONNECTOR_TOOLS.map(spec => [spec.name, spec]));

  constructor(private readonly options: ConnectorMcpEndpointOptions) {
    this.#limiter = new SlidingWindowLimiter(options.now);
  }

  async handle(request: ApiRequest): Promise<ApiResponse | undefined> {
    if (request.path !== MCP_PATH) return undefined;
    if (request.method !== 'POST') {
      return jsonRpcError(405, -32000, 'Method not allowed: this server answers POST only.', { allow: 'POST' });
    }
    const origin = request.headers.get('origin');
    if (origin !== undefined && !(this.options.allowedOrigins ?? []).includes(origin)) {
      return jsonRpcError(403, -32000, 'Forbidden: origin not allowed.');
    }
    const access = await this.#authenticate(request);
    if (access === undefined) return this.options.unauthorized(request.headers.get('authorization') !== undefined);

    const contentType = request.headers.get('content-type') ?? '';
    if (!/^application\/json\b/iu.test(contentType)) {
      return jsonRpcError(415, -32000, 'Unsupported media type: send application/json.');
    }
    let text: string;
    try {
      text = await request.text(MCP_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return jsonRpcError(413, -32000, 'Request body too large.');
      return jsonRpcError(400, -32700, 'The request body could not be read.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonRpcError(400, -32700, 'Parse error: the body is not JSON.');
    }
    if (Array.isArray(parsed)) return jsonRpcError(400, -32600, 'Batched requests are not supported.');

    const call = toolCall(parsed);
    if (call !== undefined) {
      const spec = this.#specs.get(call.name);
      const refused = this.#rateLimit(access, spec?.scope === 'fleet:write');
      if (refused !== undefined) return refused;
      // A write tool this token was not approved for is not registered, so the SDK would call it unknown. Say it
      // as the tool error the contract asks for, through the same toolbox that records the refusal.
      if (spec !== undefined && !access.scopes.includes(spec.scope)) {
        const result = await this.options.toolbox.execute(spec, call.arguments, access, this.#gateway(access));
        return {
          status: 200,
          headers: new Map(Object.entries(JSON_HEADERS)),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            result: { content: [{ type: 'text', text: result.text }], isError: true },
          }),
        };
      }
    }
    return await this.#serve(request, parsed, text, access);
  }

  async #authenticate(request: ApiRequest): Promise<ConnectorAccess | undefined> {
    const header = request.headers.get('authorization');
    const match = header === undefined ? null : /^Bearer[ \t]+([^\s]+)$/iu.exec(header);
    if (match === null || match[1] === undefined) return undefined;
    try {
      return await this.options.verifier.verify(match[1]);
    } catch {
      return undefined;
    }
  }

  #rateLimit(access: ConnectorAccess, write: boolean): ApiResponse | undefined {
    const all = `${access.grantId}:calls`;
    const writes = `${access.grantId}:writes`;
    const blocked = [
      ...(write ? [this.#limiter.peek(writes, WRITE_CALLS_PER_MINUTE)] : []),
      this.#limiter.peek(all, CALLS_PER_MINUTE),
    ].find(decision => !decision.ok);
    if (blocked !== undefined && !blocked.ok) {
      return jsonRpcError(
        429,
        -32000,
        write && this.#limiter.peek(writes, WRITE_CALLS_PER_MINUTE).ok === false
          ? 'Too many changes in a minute. Wait a little before asking for another.'
          : 'Too many calls in a minute. Wait a little before asking again.',
        { 'retry-after': String(blocked.retryAfterSeconds) },
      );
    }
    this.#limiter.take(all, CALLS_PER_MINUTE);
    if (write) this.#limiter.take(writes, WRITE_CALLS_PER_MINUTE);
    return undefined;
  }

  #gateway(access: ConnectorAccess): FleetGateway {
    return new FleetGateway(this.options.dispatch, access.grantId, this.options.newRequestId);
  }

  async #serve(request: ApiRequest, parsed: unknown, text: string, access: ConnectorAccess): Promise<ApiResponse> {
    const gateway = this.#gateway(access);
    const server = new McpServer(
      { name: 'ferretry', version: this.options.serverVersion },
      {
        instructions:
          "Ferretry controls AI agents called ferrets on the owner's machine. Answers are short and meant to be read aloud. Refer to a ferret by its call sign (first name).",
      },
    );
    for (const spec of CONNECTOR_TOOLS) {
      if (!access.scopes.includes(spec.scope)) continue;
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
        async args => {
          const result = await this.options.toolbox.execute(spec, args, access, gateway);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const accept = request.headers.get('accept') ?? '';
      const headers = new Headers({
        'content-type': 'application/json',
        accept:
          accept.includes('application/json') && accept.includes('text/event-stream')
            ? accept
            : 'application/json, text/event-stream',
      });
      const protocol = request.headers.get('mcp-protocol-version');
      if (protocol !== undefined) headers.set('mcp-protocol-version', protocol);
      const response = await transport.handleRequest(
        new Request('http://connector.invalid/mcp', { method: 'POST', headers, body: text }),
        { parsedBody: parsed },
      );
      const body = await response.text();
      const out = new Map<string, string>([['cache-control', 'no-store']]);
      for (const [key, value] of response.headers) out.set(key.toLowerCase(), value);
      out.set('cache-control', 'no-store');
      return { status: response.status, headers: out, body };
    } catch {
      return jsonRpcError(500, -32603, 'The connector could not answer that.');
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }
}

/** The `tools/call` this JSON-RPC message is, if it is one: tool name, arguments and request id. */
function toolCall(message: unknown): { name: string; arguments: unknown; id: unknown } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.method !== 'tools/call') return undefined;
  const params = record.params;
  if (typeof params !== 'object' || params === null) return { name: '', arguments: undefined, id: record.id };
  const named = params as Record<string, unknown>;
  return { name: typeof named.name === 'string' ? named.name : '', arguments: named.arguments, id: record.id };
}
