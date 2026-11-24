import { connectorActor } from '../api/actor.ts';
import { CLIENT_HEADER } from '../api/dispatcher.ts';
import { type ApiRequest, type ApiResponse, BodyTooLargeError, headersFrom, queryFrom } from '../api/http.ts';
import { errorResponse } from '../api/responses.ts';
import type { ApiHttpDispatch, ApiSurface } from '../api/server.ts';
import type { ConnectorApiAnswer, ConnectorApiCall, ConnectorApiDispatch, ConnectorHttpHandler } from './ports.ts';

/**
 * THE CONNECTOR LISTENER'S SURFACE (docs/mcp-connector.md "Where it listens").
 *
 * A listener of its own, bound on `127.0.0.1`, that `cloudflared` forwards the connector's public hostname to. It is
 * never the API listener and never the tunnel listener, and it serves NOTHING from the daemon's route table: each
 * request is offered to the connector's own handlers (the OAuth server, then `/mcp`) in order, and one no handler
 * claims is the same `404` whatever its path or method, so a prober cannot map anything.
 *
 * Its arrivals are never trusted for being local: no handler here reads `loopback`, `privilegedLoopback`, a peer
 * address or a `Host` header to decide anything, and the only credential any of them accepts is a connector token.
 * No socket is ever switched.
 */

const NOT_SERVED = errorResponse(404, 'nothing is served at this path', 'not_found');

export function connectorListenerSurface(handlers: readonly ConnectorHttpHandler[]): ApiSurface {
  const http: ApiHttpDispatch = {
    dispatch: async (request: ApiRequest): Promise<ApiResponse> => {
      for (const handler of handlers) {
        const answer = await handler.handle(request);
        if (answer !== undefined) return answer;
      }
      return NOT_SERVED;
    },
  };
  return {
    http,
    sockets: {
      claims: () => false,
      upgrade: async () => ({ outcome: 'unclaimed' }),
    },
    // Claude calls from its servers, and a browser has no business calling `/mcp` cross-origin; the `/mcp`
    // handler refuses a foreign `Origin` itself (MCP Streamable HTTP, DNS-rebinding rule).
    corsOrigins: [],
  };
}

/**
 * The ONLY header a tool may add to its in-process request: the logical request id that send, start and restart
 * require for their retry contract. Anything else a tool names is dropped — a tool can never set a credential,
 * a client identity or a session header.
 */
const TOOL_HEADERS: ReadonlySet<string> = new Set(['x-fy-request-id']);

/** The largest route body a tool may send in-process — a message is at most 8 000 characters. */
const MAX_CALL_BODY_CHARS = 64 * 1024;

/**
 * The tools' one door into the daemon: an ordinary request to the daemon's OWN route table, dispatched in-process
 * under the host admin token and self-identified as `connector:<grantId>` so the journal and the security log name
 * who acted (`resolveApiActor`).
 *
 * IT ARRIVES REMOTE, NOT AT THE MACHINE (`loopback: false`, no privileged arrival). The admin token off loopback is
 * a GOVERNED caller (docs/grants.md, `arrivedOnHost`), so the boundary applies the operator's daemon-wide grants to
 * every route the tools reach, and every act that wants a passkey step-up — confirming a held configuration change,
 * restoring a cut-off ferret, widening anything — is refused, because a connector holds no device and so no step-up.
 * Stamping it host-local instead would make it the ungoverned owner at the keyboard, which it is not. Every route's
 * own validation, ledgers, journalling and person/agent rules apply unchanged; the nine tools' fixed schemas bound
 * what is asked.
 */
export class InProcessConnectorDispatch implements ConnectorApiDispatch {
  constructor(
    private readonly deps: {
      readonly dispatch: (request: ApiRequest) => Promise<ApiResponse>;
      /** The host admin token, read when each call is made (it can be rotated while the daemon runs). */
      readonly adminToken: () => string;
    },
  ) {}

  async call(grantId: string, call: ConnectorApiCall): Promise<ConnectorApiAnswer> {
    if (!call.path.startsWith('/v1/') || call.path.includes('?') || call.path.includes('#'))
      throw new Error('a connector tool built a route path outside /v1/');
    const body = call.body === undefined ? '' : JSON.stringify(call.body);
    if (body.length > MAX_CALL_BODY_CHARS) throw new Error('a connector tool built a body over the in-process limit');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(call.headers ?? {}))
      if (TOOL_HEADERS.has(name.toLowerCase()) && /^[A-Za-z0-9._:-]{1,128}$/u.test(value))
        headers[name.toLowerCase()] = value;
    Object.assign(headers, {
      authorization: `Bearer ${this.deps.adminToken()}`,
      [CLIENT_HEADER]: connectorActor(grantId),
    });
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const request: ApiRequest = {
      method: call.method,
      path: call.path,
      query: queryFrom(Object.entries(call.query ?? {})),
      headers: headersFrom(headers),
      loopback: false,
      privilegedLoopback: false,
      text: async limitBytes => {
        if (limitBytes !== undefined && new TextEncoder().encode(body).byteLength > limitBytes)
          throw new BodyTooLargeError(limitBytes);
        return body;
      },
    };
    const response = await this.deps.dispatch(request);
    return { status: response.status, body: response.body };
  }
}
