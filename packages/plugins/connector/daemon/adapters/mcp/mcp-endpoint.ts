import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { type ApiRequest, type ApiResponse, BodyTooLargeError } from '@ferretry/kernel/contract';
import { FleetGateway } from '../../lib/mcp/gateway.ts';
import type { ConnectorDelegate, ConnectorServing } from '../../lib/mcp/ports.ts';
import { SlidingWindowLimiter } from '../../lib/mcp/rate-limit.ts';
import type { ConnectorToolbox } from '../../lib/mcp/toolbox.ts';
import { CONNECTOR_TOOLS, type ConnectorToolSpec } from '../../lib/mcp/tools/index.ts';
import type { ConnectorAccess, ConnectorAccessVerifier, ConnectorHttpHandler } from '../../lib/ports.ts';

/** The one path this handler answers. */
const MCP_PATH = '/mcp';
/** A tools/call body is a few kilobytes; a megabyte is already generous. */
const MCP_MAX_BODY_BYTES = 1024 * 1024;
/** docs/mcp-connector.md "Rate limits": per grant, per minute. */
const CALLS_PER_MINUTE = 60;
const WRITE_CALLS_PER_MINUTE = 10;
/**
 * Agenda acts — answering or snoozing an ask — have a budget of their own, apart from the other writes.
 *
 * WHY. Cleaning up the agenda is a burst by nature: the owner reads the list and settles 10–30 asks in a
 * minute. At 10 writes a minute that burst was refused part way. These two acts each settle one ask the
 * owner was already shown and start nothing, so they cannot spend money or multiply work the way a spawn,
 * restart, stop or send can; those keep the tighter 10. Both still count toward the 60 calls a minute, so
 * a runaway loop is bounded exactly as before.
 */
const AGENDA_CALLS_PER_MINUTE = 30;
const AGENDA_TOOLS: ReadonlySet<string> = new Set(['answer_attention', 'snooze_attention']);

/** Which per-minute budget a tool call spends, beside the overall one. */
type CallBudget = 'read' | 'write' | 'agenda';

function budgetOf(spec: ConnectorToolSpec | undefined): CallBudget {
  if (spec?.scope !== 'fleet:write') return 'read';
  return AGENDA_TOOLS.has(spec.name) ? 'agenda' : 'write';
}

export interface ConnectorMcpEndpointOptions {
  readonly verifier: ConnectorAccessVerifier;
  /** The OAuth part's 401 builder: `(tokenPresented) => 401 + WWW-Authenticate`. Injected so the parts stay apart. */
  readonly unauthorized: (tokenPresented: boolean) => ApiResponse;
  /** The kernel's delegated dispatch (U2): the real routes and Gate, as this grant's connector principal. */
  readonly delegate: ConnectorDelegate;
  /** Whether the connector is on right now; asked before every delegated call, so an off stops a request in flight. */
  readonly serving: ConnectorServing;
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
      const refused = this.#rateLimit(access, budgetOf(spec));
      if (refused !== undefined) return refused;
      // A write tool this token was not approved for is not registered, so the SDK would call it unknown. Say it
      // as the tool error the contract asks for, through the same toolbox that records the refusal. This reply
      // never reaches the SDK, so the transport's own envelope check is made here first: an unsupported
      // `MCP-Protocol-Version` is a 400 whatever the token may do.
      if (spec !== undefined && !access.scopes.includes(spec.scope)) {
        const version = request.headers.get('mcp-protocol-version');
        if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
          return jsonRpcError(
            400,
            -32000,
            `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
          );
        }
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

  #rateLimit(access: ConnectorAccess, budget: CallBudget): ApiResponse | undefined {
    const all = `${access.grantId}:calls`;
    const own =
      budget === 'write'
        ? { key: `${access.grantId}:writes`, limit: WRITE_CALLS_PER_MINUTE }
        : budget === 'agenda'
          ? { key: `${access.grantId}:agenda`, limit: AGENDA_CALLS_PER_MINUTE }
          : undefined;
    const ownDecision = own === undefined ? undefined : this.#limiter.peek(own.key, own.limit);
    const blocked = [
      ...(ownDecision === undefined ? [] : [ownDecision]),
      this.#limiter.peek(all, CALLS_PER_MINUTE),
    ].find(decision => !decision.ok);
    if (blocked !== undefined && !blocked.ok) {
      return jsonRpcError(
        429,
        -32000,
        ownDecision?.ok === false
          ? 'Too many changes in a minute. Wait a little before asking for another.'
          : 'Too many calls in a minute. Wait a little before asking again.',
        { 'retry-after': String(blocked.retryAfterSeconds) },
      );
    }
    this.#limiter.take(all, CALLS_PER_MINUTE);
    if (own !== undefined) this.#limiter.take(own.key, own.limit);
    return undefined;
  }

  #gateway(access: ConnectorAccess): FleetGateway {
    return new FleetGateway(this.options.delegate, access.grantId, this.options.newRequestId, this.options.serving);
  }

  async #serve(request: ApiRequest, parsed: unknown, text: string, access: ConnectorAccess): Promise<ApiResponse> {
    const gateway = this.#gateway(access);
    const server = new McpServer(
      { name: 'ferretry', version: this.options.serverVersion },
      {
        instructions:
          "Ferretry controls AI agents called ferrets on the owner's machine. Answers are short and meant to be read aloud, except get_attention, which returns one whole agenda item. Refer to a ferret by its call sign (first name).",
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
