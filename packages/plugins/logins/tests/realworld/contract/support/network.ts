/**
 * The loopback stand-ins a Codex under contract reaches (ported from v4's `fleet/tests/contract/support/network.ts`,
 * Codex half: no TLS material, Codex takes its token endpoint from `CODEX_REFRESH_TOKEN_URL_OVERRIDE`).
 *
 * - {@link startProxy} is what every `HTTPS_PROXY` points at: it logs each `CONNECT` target and closes the tunnel, so a
 *   request can be OBSERVED without ever being sent.
 * - {@link startTokenEndpoint} is a plain-HTTP OAuth token endpoint.
 * - {@link startFakeBus} is a unix socket posing as the D-Bus session bus, so a keyring call is a connection to count.
 *
 * Every token these hand out is a fake made up here.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export interface RecordingProxy {
  readonly port: number;
  /** Every `CONNECT host:port` seen, in arrival order. */
  readonly connects: string[];
  stop(): void;
}

/** Every CONNECT is recorded and closed. */
export function startProxy(): RecordingProxy {
  const connects: string[] = [];
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, bytes) {
        const line = new TextDecoder().decode(bytes).split('\r\n')[0] ?? '';
        const [method, target = ''] = line.split(' ');
        connects.push(method === 'CONNECT' ? target : `${method} ${target}`);
        socket.end();
      },
    },
  });
  return { port: listener.port, connects, stop: () => listener.stop(true) };
}

export interface TokenEndpoint {
  readonly port: number;
  readonly url: string;
  /** The refresh tokens presented, one per POST. */
  readonly presented: string[];
  /** The refresh token the most recent answer issued. */
  lastIssued(): string | undefined;
  /** While held, every POST waits — the window in which a lock is observably held. */
  hold(): void;
  release(): void;
  stop(): void;
}

/** `issue(n)` builds the n-th answer's JSON body. */
export function startTokenEndpoint(options: {
  readonly issue: (n: number) => { readonly body: Record<string, unknown>; readonly refreshToken: string };
}): TokenEndpoint {
  const presented: string[] = [];
  let issued: string | undefined;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response('not here', { status: 404 });
      const text = await request.text();
      let token = '';
      try {
        token = String((JSON.parse(text) as { refresh_token?: unknown }).refresh_token ?? '');
      } catch {
        token = new URLSearchParams(text).get('refresh_token') ?? '';
      }
      presented.push(token);
      const n = presented.length;
      if (gate !== undefined) await gate;
      const answer = options.issue(n);
      issued = answer.refreshToken;
      return Response.json(answer.body);
    },
  });
  const scheme = 'http';
  return {
    port: server.port ?? 0,
    url: `${scheme}://127.0.0.1:${server.port}/oauth/token`,
    presented,
    lastIssued: () => issued,
    hold() {
      gate = new Promise(resolve => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = undefined;
    },
    stop: () => {
      open?.();
      server.stop(true);
    },
  };
}

export interface FakeBus {
  readonly address: string;
  connections(): number;
  stop(): Promise<void>;
}

/**
 * A unix socket that only counts connections. Its directory is under `/tmp` deliberately: a socket
 * path must fit `sun_path` (108 bytes on Linux), and a nested temporary directory can exceed it.
 */
export async function startFakeBus(directory: string): Promise<FakeBus> {
  await mkdir(directory, { recursive: true });
  const socketPath = path.join(directory, 'bus');
  let count = 0;
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open() {
        count++;
      },
      data() {},
    },
  });
  return {
    address: `unix:path=${socketPath}`,
    connections: () => count,
    stop: async () => {
      listener.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
