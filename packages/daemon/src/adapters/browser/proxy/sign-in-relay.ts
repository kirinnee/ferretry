import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import {
  badRequest,
  basicProxyAuthorization,
  CONNECT_ESTABLISHED,
  type Destination,
  forwardedHead,
  gatewayFailure,
  headEnd,
  MAX_HEAD_BYTES,
  type ProxyEndpoint,
  parseAuthority,
  parsePlainTarget,
  parseRequestHead,
  proxyUnreachable,
} from '../../../lib/browser/proxy/index.ts';
import { dial, openTunnel, type ProxyCredentials, Reader } from './tunnel.ts';

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * A loopback HTTP proxy that signs in to the real proxy for Chrome. Chrome's `--proxy-server` cannot carry a
 * username or password, and putting them on the command line would show them in every process list, so Chrome
 * is pointed here instead and this holds the credentials in memory for as long as the browser runs. It listens
 * on 127.0.0.1 only, and it reaches nothing but the one proxy it was started for.
 */
export class ProxySignInRelay {
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly upstream: ProxyEndpoint,
    private readonly credentials: ProxyCredentials,
    private readonly connectTimeoutMs: number,
  ) {}

  static async start(
    upstream: ProxyEndpoint,
    credentials: ProxyCredentials,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  ): Promise<ProxySignInRelay> {
    const server = createServer();
    const relay = new ProxySignInRelay(server, upstream, credentials, connectTimeoutMs);
    server.on('connection', socket => {
      relay.track(socket);
      void relay.serve(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return relay;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }

  private async serve(client: Socket): Promise<void> {
    const reader = new Reader(client);
    try {
      const { result: end, buffer } = await reader.until(buffer => {
        const found = headEnd(buffer);
        if (found >= 0) return found;
        return buffer.length > MAX_HEAD_BYTES ? -1 : undefined;
      });
      if (end < 0) return this.refuse(client, badRequest());
      const head = parseRequestHead(new TextDecoder().decode(buffer.subarray(0, end)));
      if (head === undefined) return this.refuse(client, badRequest());
      reader.consume(end);
      if (head.method === 'CONNECT') {
        const destination = parseAuthority(head.target);
        if (destination === undefined) return this.refuse(client, badRequest());
        await this.tunnel(client, reader, destination);
        return;
      }
      const plain = parsePlainTarget(head.target);
      if (plain === undefined) return this.refuse(client, badRequest());
      await this.forward(client, reader, head, plain);
    } catch {
      this.refuse(client, gatewayFailure(proxyUnreachable(this.upstream)));
    }
  }

  private refuse(client: Socket, response: string): void {
    client.end(response);
  }

  private async tunnel(client: Socket, reader: Reader, destination: Destination): Promise<void> {
    const opened = await this.open(destination);
    if (typeof opened === 'string') return this.refuse(client, gatewayFailure(opened));
    client.write(CONNECT_ESTABLISHED);
    this.splice(client, reader, opened);
  }

  private async forward(
    client: Socket,
    reader: Reader,
    head: NonNullable<ReturnType<typeof parseRequestHead>>,
    plain: NonNullable<ReturnType<typeof parsePlainTarget>>,
  ): Promise<void> {
    if (this.upstream.scheme === 'socks5') {
      const opened = await this.open(plain.destination);
      if (typeof opened === 'string') return this.refuse(client, gatewayFailure(opened));
      opened.socket.write(forwardedHead(head, plain.path));
      this.splice(client, reader, opened);
      return;
    }
    const socket = await dial(this.upstream, this.connectTimeoutMs);
    this.track(socket);
    const auth = basicProxyAuthorization(this.credentials.username, this.credentials.password);
    socket.write(forwardedHead(head, head.target, auth));
    this.splice(client, reader, { socket, leftover: new Uint8Array(0) });
  }

  private splice(client: Socket, reader: Reader, upstream: { socket: Socket; leftover: Uint8Array }): void {
    const early = reader.release();
    if (early.length > 0) upstream.socket.write(early);
    if (upstream.leftover.length > 0) client.write(upstream.leftover);
    upstream.socket.on('error', () => client.destroy());
    client.on('error', () => upstream.socket.destroy());
    client.pipe(upstream.socket);
    upstream.socket.pipe(client);
  }

  /** A tunnel to `destination` through the upstream proxy, or the sentence saying why it could not be made. */
  private async open(destination: Destination): Promise<{ socket: Socket; leftover: Uint8Array } | string> {
    const tunnel = await openTunnel({
      upstream: this.upstream,
      credentials: this.credentials,
      destination,
      connectTimeoutMs: this.connectTimeoutMs,
      track: socket => this.track(socket),
    });
    return tunnel.ok ? { socket: tunnel.socket, leftover: tunnel.leftover } : tunnel.sentence;
  }
}
