import { type AddressInfo, createServer, type Server, type Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  badRequest,
  basicProxyAuthorization,
  CONNECT_ESTABLISHED,
  connectHead,
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
  responseStatus,
  socks5,
} from '../../../lib/browser/proxy/index.ts';

export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** A byte stream read a piece at a time, so a handshake can wait for exactly the reply it needs. */
class Reader {
  private buffer = new Uint8Array(0);
  private waiting: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      const next = new Uint8Array(this.buffer.length + chunk.length);
      next.set(this.buffer);
      next.set(chunk, this.buffer.length);
      this.buffer = next;
      this.wake();
    });
    socket.on('error', error => {
      this.failure = error;
      this.wake();
    });
    socket.on('close', () => {
      this.failure ??= new Error('the connection closed');
      this.wake();
    });
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  /** Waits until `ready` accepts what has arrived. Resolves with the buffer; rejects when the connection ends first. */
  async until<T>(ready: (buffer: Uint8Array) => T | undefined): Promise<{ result: T; buffer: Uint8Array }> {
    for (;;) {
      const result = ready(this.buffer);
      if (result !== undefined) return { result, buffer: this.buffer };
      if (this.failure !== undefined) throw this.failure;
      await new Promise<void>(resolve => {
        this.waiting = resolve;
      });
    }
  }

  /** Takes the first `count` bytes off, handing back what is left over for the caller to forward. */
  consume(count: number): Uint8Array {
    this.buffer = this.buffer.subarray(count);
    return this.buffer;
  }

  /** Stops listening: whatever has not been taken stays with the caller. */
  release(): Uint8Array {
    this.socket.removeAllListeners('data');
    const rest = this.buffer;
    this.buffer = new Uint8Array(0);
    return rest;
  }
}

function dial(upstream: ProxyEndpoint, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      upstream.scheme === 'https'
        ? tlsConnect({ host: upstream.host, port: upstream.port, servername: upstream.host })
        : tcpConnect({ host: upstream.host, port: upstream.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out'));
    }, timeoutMs);
    socket.once(upstream.scheme === 'https' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

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
    let socket: Socket;
    try {
      socket = await dial(this.upstream, this.connectTimeoutMs);
    } catch {
      return proxyUnreachable(this.upstream);
    }
    this.track(socket);
    try {
      const leftover =
        this.upstream.scheme === 'socks5'
          ? await this.socksHandshake(socket, destination)
          : await this.httpConnect(socket, destination);
      return typeof leftover === 'string' ? (socket.destroy(), leftover) : { socket, leftover };
    } catch {
      socket.destroy();
      return proxyUnreachable(this.upstream);
    }
  }

  private async httpConnect(socket: Socket, destination: Destination): Promise<Uint8Array | string> {
    const reader = new Reader(socket);
    socket.write(
      connectHead(destination, basicProxyAuthorization(this.credentials.username, this.credentials.password)),
    );
    const { result } = await reader.until(buffer => responseStatus(buffer));
    if (result.code === 407) return 'the browser proxy refused the username and password';
    if (result.code !== 200)
      return `the browser proxy answered ${result.code === 0 ? 'with something that is not HTTP' : result.code} to the connection`;
    reader.consume(result.length);
    return reader.release();
  }

  private async socksHandshake(socket: Socket, destination: Destination): Promise<Uint8Array | string> {
    const reader = new Reader(socket);
    socket.write(socks5.greeting(true));
    const { result: method } = await reader.until(buffer => socks5.methodChoice(buffer));
    reader.consume(2);
    if (method === 'refused') return 'the browser proxy accepts neither sign-in nor anonymous use';
    if (method === 'password') {
      const request = socks5.authRequest(this.credentials.username, this.credentials.password);
      if (request === undefined) return 'the browser proxy username or password is empty or longer than SOCKS5 allows';
      socket.write(request);
      const { result: accepted } = await reader.until(buffer => socks5.authAccepted(buffer));
      reader.consume(2);
      if (!accepted) return 'the browser proxy refused the username and password';
    }
    const connect = socks5.connectRequest(destination);
    if (connect === undefined) return 'that address cannot be sent through a SOCKS5 proxy';
    socket.write(connect);
    const { result } = await reader.until(buffer => {
      const reply = socks5.connectReply(buffer);
      return reply.state === 'incomplete' ? undefined : reply;
    });
    if (result.state === 'failed') return `the browser proxy could not open the connection: ${result.why}`;
    reader.consume(result.length);
    return reader.release();
  }
}
