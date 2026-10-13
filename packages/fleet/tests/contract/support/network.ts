/**
 * The only "network" a harness under contract ever reaches: loopback stand-ins that record.
 *
 * - {@link startProxy} is what every `HTTPS_PROXY` points at. It logs each `CONNECT` target and
 *   closes the tunnel, so a request can be OBSERVED without ever being sent — including any
 *   inference attempt, which dies at the CONNECT line with no body written.
 * - For the one host a test needs answered (Claude's token endpoint) the proxy splices the tunnel to
 *   a local TLS server holding a leaf certificate from a throwaway CA, trusted by the child through
 *   `NODE_EXTRA_CA_CERTS` only. Nothing the person running this trusts is changed.
 * - {@link startTokenEndpoint} is a plain-HTTP OAuth token endpoint for Codex, which takes its
 *   address from `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.
 * - {@link startFakeBus} is a unix socket posing as the D-Bus session bus, so a keyring call is a
 *   connection this test can count.
 *
 * Every token these hand out is a fake made up here.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contract, run } from './harness.ts';

export interface RecordingProxy {
  readonly port: number;
  /** Every `CONNECT host:port` seen, in arrival order. */
  readonly connects: string[];
  stop(): void;
}

interface Tunnel {
  upstream?: Bun.Socket<undefined>;
  connecting: boolean;
  /** Bytes a client sent while its upstream was still being dialled. */
  pending: Uint8Array[];
}

/** `spliceTo` names the hosts answered by a local TLS port; every other CONNECT is recorded and closed. */
export function startProxy(spliceTo: Readonly<Record<string, number>> = {}): RecordingProxy {
  const connects: string[] = [];
  const listener = Bun.listen<Tunnel>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { connecting: false, pending: [] };
      },
      async data(socket, bytes) {
        const tunnel = socket.data;
        if (tunnel.upstream !== undefined) {
          tunnel.upstream.write(bytes);
          return;
        }
        if (tunnel.connecting) {
          tunnel.pending.push(bytes);
          return;
        }
        const line = new TextDecoder().decode(bytes).split('\r\n')[0] ?? '';
        const [method, target = ''] = line.split(' ');
        connects.push(method === 'CONNECT' ? target : `${method} ${target}`);
        const host = target.split(':')[0] ?? '';
        const port = method === 'CONNECT' ? spliceTo[host] : undefined;
        if (port === undefined) {
          socket.end();
          return;
        }
        tunnel.connecting = true;
        const upstream = await Bun.connect({
          hostname: '127.0.0.1',
          port,
          socket: {
            data(_upstream, reply) {
              socket.write(reply);
            },
            close() {
              socket.end();
            },
          },
        });
        tunnel.upstream = upstream;
        tunnel.connecting = false;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        for (const early of tunnel.pending.splice(0)) upstream.write(early);
      },
      close(socket) {
        socket.data.upstream?.end();
      },
    },
  });
  return { port: listener.port, connects, stop: () => listener.stop(true) };
}

export interface TlsMaterial {
  readonly caFile: string;
  readonly cert: string;
  readonly key: string;
}

/** A throwaway CA and one leaf for `hosts`, made with the pinned openssl, valid for one day. */
export async function makeTlsMaterial(directory: string, hosts: readonly string[]): Promise<TlsMaterial> {
  await mkdir(directory, { recursive: true });
  const at = (name: string) => path.join(directory, name);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' };
  const step = async (args: string[]) => {
    const done = await run([contract.openssl, ...args], { env, timeoutMs: 60_000 });
    if (done.code !== 0) throw new Error(`openssl ${args[0]} failed: ${done.stderr}`);
  };
  await step([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    at('ca.key'),
    '-out',
    at('ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=fy-contract-test-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);
  await step([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    at('leaf.key'),
    '-out',
    at('leaf.csr'),
    '-subj',
    `/CN=${hosts[0]}`,
  ]);
  await writeFile(
    at('leaf.ext'),
    `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nextendedKeyUsage=serverAuth\n`,
  );
  await step([
    'x509',
    '-req',
    '-in',
    at('leaf.csr'),
    '-CA',
    at('ca.pem'),
    '-CAkey',
    at('ca.key'),
    '-CAcreateserial',
    '-out',
    at('leaf.pem'),
    '-days',
    '1',
    '-extfile',
    at('leaf.ext'),
  ]);
  return {
    caFile: at('ca.pem'),
    cert: await Bun.file(at('leaf.pem')).text(),
    key: await Bun.file(at('leaf.key')).text(),
  };
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

/** One token endpoint shape for both harnesses: `issue(n)` builds the n-th answer's JSON body. */
export function startTokenEndpoint(options: {
  readonly tls?: TlsMaterial;
  readonly issue: (n: number) => { readonly body: Record<string, unknown>; readonly refreshToken: string };
}): TokenEndpoint {
  const presented: string[] = [];
  let issued: string | undefined;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    ...(options.tls === undefined ? {} : { tls: { cert: options.tls.cert, key: options.tls.key } }),
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
  const scheme = options.tls === undefined ? 'http' : 'https';
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
