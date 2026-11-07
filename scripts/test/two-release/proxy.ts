/**
 * A loopback proxy that RECORDS what `fy` sent a daemon (redesign §10.5): the client-side witness for the fy leg.
 *
 * `fy` is aimed at this proxy (`FY_URL`); the proxy forwards every HTTP request, and every WebSocket upgrade, to the
 * daemon's own loopback listener and writes down `METHOD /path` for each. A case that says "nothing was attempted"
 * reads {@link RecordingProxy.paths} and finds only the inventory and health reads. The proxy runs in the test's own
 * process, so `fy`'s own-listener check (same user, same machine) passes.
 *
 * It records paths and methods only: never a header, a body or a credential. It FORWARDS the credential, on a plain
 * request and on a WebSocket upgrade alike (the event feed authenticates with an `authorization` header on the
 * upgrade), and writes it nowhere.
 */
import type { Server, ServerWebSocket } from 'bun';

export interface RecordingProxy {
  /** The proxy's origin, for `FY_URL`. */
  readonly url: string;
  /** `GET /v1/plugins`, in the order they arrived. Query strings are dropped. */
  paths(): readonly string[];
  /** Every WebSocket upgrade attempted, as `GET /path`. */
  upgrades(): readonly string[];
  reset(): void;
  stop(): Promise<void>;
}

interface Tunnel {
  readonly target: string;
  /** The upgrade request's own headers, minus the hop-by-hop ones; the upstream upgrade carries them. */
  readonly headers: Readonly<Record<string, string>>;
  upstream?: WebSocket;
  readonly queued: (string | Uint8Array<ArrayBuffer>)[];
}

const DROPPED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/** Headers that belong to ONE hop of the upgrade: the proxy's own handshake with the client, not the daemon's. */
const HOP_HEADERS = new Set(['host', 'connection', 'upgrade', 'content-length']);

/** The request's headers for the upstream upgrade: everything but the hop headers and the `sec-websocket-*` handshake. */
function upgradeHeaders(request: Request): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

/** Bun's `WebSocket` takes request headers as a second argument, which the DOM type does not know. */
const openUpstream = (target: string, headers: Record<string, string>): WebSocket =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(target, {
    headers,
  });

export function recordingProxy(daemonUrl: string): RecordingProxy {
  const seen: string[] = [];
  const upgraded: string[] = [];
  const server: Server<Tunnel> = Bun.serve<Tunnel>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, serving) {
      const url = new URL(request.url);
      const target = new URL(`${url.pathname}${url.search}`, daemonUrl);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        upgraded.push(`GET ${url.pathname}`);
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        return serving.upgrade(request, {
          data: { target: target.toString(), headers: upgradeHeaders(request), queued: [] },
        })
          ? undefined
          : new Response('upgrade failed', { status: 400 });
      }
      seen.push(`${request.method} ${url.pathname}`);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      const upstream = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
      const answer = new Headers();
      for (const [name, value] of upstream.headers) if (!DROPPED.has(name.toLowerCase())) answer.set(name, value);
      return new Response(upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: answer,
      });
    },
    websocket: {
      open(socket: ServerWebSocket<Tunnel>) {
        const upstream = openUpstream(socket.data.target, { ...socket.data.headers });
        socket.data.upstream = upstream;
        upstream.binaryType = 'arraybuffer';
        upstream.onopen = () => {
          for (const frame of socket.data.queued.splice(0)) upstream.send(frame);
        };
        upstream.onmessage = event => {
          const data = event.data as string | ArrayBuffer;
          socket.send(typeof data === 'string' ? data : new Uint8Array(data));
        };
        upstream.onclose = () => socket.close();
      },
      message(socket, message) {
        const frame = typeof message === 'string' ? message : new Uint8Array(message);
        if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(frame);
        else socket.data.queued.push(frame);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    paths: () => [...seen],
    upgrades: () => [...upgraded],
    reset: () => {
      seen.length = 0;
      upgraded.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
