import type { Server, ServerWebSocket } from 'bun';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import { finalised, headersFrom, queryFrom } from '../contract/http.ts';
import { BodyTooLargeError, MAX_REQUEST_BODY_BYTES } from '../contract/body.ts';
import type { LocalArrival } from '../contract/session.ts';
import { DAEMON_RUN_FILE, DAEMON_SOCKET_FILE, type DaemonRun, recordedBindAddress } from '../contract/run.ts';
import type { SocketHandler } from '../contract/socket.ts';
import { SOCKET_CLOSES, SOCKET_MAX_FRAME_BYTES, SOCKET_MAX_PENDING_FRAMES } from '../contract/socket.ts';
import type { Listening, RunningHost } from './host.ts';

/**
 * The ONLY constructor of a local arrival (§4.8, D6). The brand symbol is not exported from the leaf, so no carrier,
 * header, body or plugin can build one: a relayed or tunnelled loopback call is remote (G14, G15).
 */
export function localArrival(privileged: boolean): LocalArrival {
  return Object.freeze({ kind: 'local', privileged }) as unknown as LocalArrival;
}

/** IPv4 127/8, IPv6 ::1 and the v4-mapped form; nothing else is loopback (today's `isLoopbackPeer`). */
export function isLoopbackPeer(address: string): boolean {
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

export { recordedBindAddress };
export const runSocketPath = (home: string): string => `${home}/${DAEMON_SOCKET_FILE}`;
export const runBindPath = (home: string): string => `${home}/${DAEMON_RUN_FILE}`;


/** Reads at most `limit` bytes piece by piece; `request.text()` would allocate the whole body first. */
async function boundedText(request: Request, limit: number | undefined): Promise<string> {
  if (limit === undefined) return await request.text();
  const reader = request.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Translates a runtime request. `arrival` is decided HERE from the listener and the socket's real peer (G14). */
export function toApiRequest(request: Request, arrival: LocalArrival, clientAddress: string | undefined): ApiRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    // The raw, still-percent-encoded path, which is what the router must match.
    path: url.pathname,
    query: queryFrom(url.searchParams),
    headers: headersFrom(Object.fromEntries(request.headers)),
    ...(clientAddress === undefined ? {} : { clientAddress }),
    arrival,
    signal: request.signal,
    text: limit => boundedText(request, limit),
  };
}

/** The final check is the last synchronous step before bytes leave (I74): `finalised`, then the Response. */
export function toResponse(response: ApiResponse, acceptsGzip: boolean): Response {
  const last = finalised(response);
  const headers = new Headers();
  for (const [name, value] of last.headers) headers.set(name, value);
  if (last.gzip !== undefined && acceptsGzip) {
    headers.set('content-encoding', 'gzip');
    return new Response(new Uint8Array(last.gzip), { status: last.status, headers });
  }
  return new Response(last.status === 304 ? null : last.body, { status: last.status, headers });
}

interface SocketData {
  handler?: SocketHandler;
  pending: (string | Uint8Array)[];
  closed: boolean;
  attach: (downstream: import('../contract/socket.ts').SocketDownstream) => Promise<SocketHandler>;
}

function serve(
  host: RunningHost,
  privileged: (peer: string | undefined) => boolean | 'refuse',
  bind: { unix: string } | { hostname: string; port: number },
): Server<SocketData> {
  const fetch = async (request: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const peer = 'unix' in bind ? undefined : server.requestIP(request)?.address;
    const decided = privileged(peer);
    if (decided === 'refuse') return new Response('{"error":"not a local caller","code":"not_local"}', { status: 403 });
    const api = toApiRequest(request, localArrival(decided), peer);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const decision = await host.dispatcher.upgrade(api);
      if (decision.outcome === 'refused') return toResponse(decision.response, false);
      if (decision.outcome === 'accepted') {
        const data: SocketData = { pending: [], closed: false, attach: decision.attach };
        return server.upgrade(request, { data }) ? undefined : new Response('upgrade failed', { status: 400 });
      }
    }
    const response = await host.dispatch(api);
    return toResponse(response, (request.headers.get('accept-encoding') ?? '').includes('gzip'));
  };
  const downstreamOf = (socket: ServerWebSocket<SocketData>): import('../contract/socket.ts').SocketDownstream => ({
    // The per-frame permit is asked synchronously, immediately before the socket write (§7.3).
    send: (frame, permit) => {
      if (socket.data.closed) return undefined;
      let showable = true;
      try {
        showable = permit === undefined ? true : permit() === true;
      } catch {
        showable = false;
      }
      if (!showable) {
        socket.data.closed = true;
        socket.close(SOCKET_CLOSES.unauthorized.code, SOCKET_CLOSES.unauthorized.reason);
        return undefined;
      }
      return socket.send(frame);
    },
    close: (code, reason) => {
      socket.data.closed = true;
      socket.close(code, reason);
    },
    bufferedBytes: () => socket.getBufferedAmount(),
  });
  return Bun.serve<SocketData>({
    ...bind,
    // Today's body cap, enforced by the runtime: an oversized body is refused before this heap holds it.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch,
    websocket: {
      maxPayloadLength: SOCKET_MAX_FRAME_BYTES,
      open: socket => {
        void socket.data
          .attach(downstreamOf(socket))
          .then(async handler => {
            socket.data.handler = handler;
            await handler.open();
            for (const frame of socket.data.pending.splice(0)) handler.fromClient(frame);
          })
          .catch(() => socket.close(SOCKET_CLOSES.unavailable.code, SOCKET_CLOSES.unavailable.reason));
      },
      message: (socket, message) => {
        const frame = typeof message === 'string' ? message : new Uint8Array(message);
        if (socket.data.handler !== undefined) {
          socket.data.handler.fromClient(frame);
          return;
        }
        if (socket.data.pending.length >= SOCKET_MAX_PENDING_FRAMES) {
          socket.close(SOCKET_CLOSES.handshakeOverflow.code, SOCKET_CLOSES.handshakeOverflow.reason);
          return;
        }
        socket.data.pending.push(frame);
      },
      close: (socket, code, reason) => {
        if (socket.data.closed && socket.data.handler === undefined) return;
        socket.data.closed = true;
        socket.data.handler?.close({ code, reason });
      },
    },
  });
}

/**
 * The local listener (§2.2 Kernel): the Unix socket `run/fyd.sock` (owner-only, privileged) and the loopback port
 * (privileged only when the peer is loopback, which on a `127.0.0.1` bind it always is; anything else is refused).
 * Every other arrival is a carrier's, through the session layer.
 */
export async function listenLocal(
  host: RunningHost,
  options: {
    readonly home: string;
    readonly port: number;
    readonly hostname?: string;
    readonly pid: number;
    readonly version: string;
    readonly write: (path: string, text: string) => Promise<void>;
    readonly chmod: (path: string, mode: number) => Promise<void>;
    readonly remove: (path: string) => Promise<void>;
  },
): Promise<Listening> {
  const socketPath = runSocketPath(options.home);
  // A Unix socket path longer than the platform limit (104 bytes on macOS, 108 on Linux) binds nothing usable.
  if (Buffer.byteLength(socketPath) > 103)
    throw new Error(
      `The home path is too long for the local socket (${socketPath}); point FY_HOME at a shorter folder.`,
    );
  await options.remove(socketPath);
  const unix = serve(host, () => true, { unix: socketPath });
  await options.chmod(socketPath, 0o600);
  const hostname = options.hostname ?? '127.0.0.1';
  const tcp = serve(host, peer => (peer !== undefined && isLoopbackPeer(peer) ? true : 'refuse'), {
    hostname,
    port: options.port,
  });
  const bind: DaemonRun = {
    format: 1,
    socket: socketPath,
    host: hostname,
    port: tcp.port ?? options.port,
    pid: options.pid,
    version: options.version,
  };
  await options.write(runBindPath(options.home), `${JSON.stringify(bind)}\n`);
  return {
    addresses: [socketPath, recordedBindAddress(bind)],
    stop: async () => {
      await Promise.all([unix.stop(true), tcp.stop(true)]);
      await options.remove(socketPath);
      await options.remove(runBindPath(options.home));
    },
  };
}
