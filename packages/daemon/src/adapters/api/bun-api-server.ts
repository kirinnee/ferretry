import {
  headersFrom,
  queryFrom,
  type ApiBindOptions,
  type ApiDispatcher,
  type ApiRequest,
  type ApiServerHandle,
  type ApiServerPort,
} from '../../lib/api/index.ts';

/** The runtime's HTTP server, behind the one function this adapter needs from it. Injected so the
 *  translation from a `Request` to an `ApiRequest` can be exercised without binding a socket. */
export interface HttpServePort {
  serve(options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Promise<Response>;
  }): BoundHttpServer;
}

export interface BoundHttpServer {
  readonly port: number;
  readonly hostname: string;
  requestIp(request: Request): string | undefined;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Bun's `serve`, adapted to `HttpServePort`. */
export class BunHttpServe implements HttpServePort {
  serve(options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Promise<Response>;
  }): BoundHttpServer {
    const server = Bun.serve({
      hostname: options.hostname,
      port: options.port,
      // A scrape or a poll that goes quiet must not hold a connection open forever.
      idleTimeout: 30,
      fetch: options.fetch,
    });
    return {
      // Bun's declared types make these optional for the unix-socket case; a TCP `serve` always
      // reports both, and a daemon that could not learn its own address has nothing to hand a client.
      port: server.port ?? options.port,
      hostname: server.hostname ?? options.hostname,
      requestIp: request => server.requestIP(request)?.address,
      stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    };
  }
}

/**
 * Serves an `ApiDispatcher` over HTTP.
 *
 * Everything transport-shaped lives here: reading the peer address, lowercasing header names,
 * flattening the query string, and turning the domain's `ApiResponse` back into a `Response`. The
 * dispatcher itself never sees a socket, which is why the entire routing and authorization surface
 * is unit-testable.
 */
export class BunApiServer implements ApiServerPort {
  constructor(private readonly http: HttpServePort = new BunHttpServe()) {}

  async listen(dispatcher: ApiDispatcher, options: ApiBindOptions): Promise<ApiServerHandle> {
    const server = this.http.serve({
      hostname: options.host,
      port: options.port,
      fetch: async (request: Request) => {
        const response = await dispatcher.dispatch(toApiRequest(request, server.requestIp(request)));
        return new Response(response.body, {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        });
      },
    });
    return {
      // Bracketed for IPv6, so the URL a client is handed is one it can actually parse.
      url: `http://${server.hostname.includes(':') ? `[${server.hostname}]` : server.hostname}:${server.port}`,
      port: server.port,
      stop: async () => {
        // `true` closes connections still open: a daemon shutting down must not be held up by a
        // scraper's keep-alive.
        await server.stop(true);
      },
    };
  }
}

/** Translates a runtime `Request` into the transport-free shape the domain routes on. */
export function toApiRequest(request: Request, remoteAddress: string | undefined): ApiRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    // `URL.pathname` is the raw, still-percent-encoded path, which is what the router must match.
    path: url.pathname,
    query: queryFrom(url.searchParams),
    headers: headersFrom(Object.fromEntries(request.headers)),
    loopback: remoteAddress !== undefined && LOOPBACK.has(remoteAddress),
    text: () => request.text(),
  };
}
