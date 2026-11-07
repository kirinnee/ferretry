import { isIP, type Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  basicProxyAuthorization,
  classifyNetworkError,
  connectHead,
  type Destination,
  type ProbeFailure,
  type ProxyEndpoint,
  proxyUnreachable,
  responseStatus,
  socks5,
} from '../../../lib/browser/proxy/index.ts';

export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

/** A byte stream read a piece at a time, so a handshake can wait for exactly the reply it needs. */
export class Reader {
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

export function dial(upstream: ProxyEndpoint, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      upstream.scheme === 'https'
        ? tlsConnect({
            host: upstream.host,
            port: upstream.port,
            // Node refuses an IP address as a TLS server name, so an address proxy is verified by that address alone.
            ...(isIP(upstream.host) === 0 ? { servername: upstream.host } : {}),
          })
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

/** A tunnel to the destination, or why there is none: the class for a test, the sentence for the browser's page. */
export type TunnelOutcome =
  | { readonly ok: true; readonly socket: Socket; readonly leftover: Uint8Array }
  | { readonly ok: false; readonly errorClass: ProbeFailure; readonly sentence: string };

const failed = (errorClass: ProbeFailure, sentence: string): TunnelOutcome => ({ ok: false, errorClass, sentence });

/**
 * A tunnel to `destination` through `upstream`, signing in with `credentials` when there are any. HTTP and HTTPS
 * proxies are asked to CONNECT with Basic sign-in; SOCKS5 uses RFC 1929 user name and password. `track` sees the
 * socket the moment it exists, so a caller that tears everything down can reach one still mid-handshake.
 */
export async function openTunnel(options: {
  readonly upstream: ProxyEndpoint;
  readonly credentials?: ProxyCredentials;
  readonly destination: Destination;
  readonly connectTimeoutMs: number;
  readonly track?: (socket: Socket) => void;
}): Promise<TunnelOutcome> {
  const { upstream, credentials, destination } = options;
  let socket: Socket;
  try {
    socket = await dial(upstream, options.connectTimeoutMs);
  } catch (error) {
    return failed(classifyNetworkError(error), proxyUnreachable(upstream));
  }
  options.track?.(socket);
  try {
    const result =
      upstream.scheme === 'socks5'
        ? await socksHandshake(socket, destination, credentials)
        : await httpConnect(socket, destination, credentials);
    if ('sentence' in result) {
      socket.destroy();
      return result;
    }
    return { ok: true, socket, leftover: result.leftover };
  } catch (error) {
    socket.destroy();
    return failed(classifyNetworkError(error), proxyUnreachable(upstream));
  }
}

type Handshake = { readonly leftover: Uint8Array } | Extract<TunnelOutcome, { ok: false }>;

async function httpConnect(
  socket: Socket,
  destination: Destination,
  credentials: ProxyCredentials | undefined,
): Promise<Handshake> {
  const reader = new Reader(socket);
  socket.write(
    connectHead(
      destination,
      credentials === undefined ? undefined : basicProxyAuthorization(credentials.username, credentials.password),
    ),
  );
  const { result } = await reader.until(buffer => responseStatus(buffer));
  if (result.code === 407) {
    return failed('auth', 'the browser proxy refused the username and password');
  }
  if (result.code !== 200)
    return failed(
      'proxy',
      `the browser proxy answered ${result.code === 0 ? 'with something that is not HTTP' : result.code} to the connection`,
    );
  reader.consume(result.length);
  return { leftover: reader.release() };
}

async function socksHandshake(
  socket: Socket,
  destination: Destination,
  credentials: ProxyCredentials | undefined,
): Promise<Handshake> {
  const reader = new Reader(socket);
  socket.write(socks5.greeting(credentials !== undefined));
  const { result: method } = await reader.until(buffer => socks5.methodChoice(buffer));
  reader.consume(2);
  if (method === 'refused') return failed('auth', 'the browser proxy accepts neither sign-in nor anonymous use');
  if (method === 'password') {
    const request =
      credentials === undefined ? undefined : socks5.authRequest(credentials.username, credentials.password);
    if (request === undefined)
      return failed('auth', 'the browser proxy username or password is empty or longer than SOCKS5 allows');
    socket.write(request);
    const { result: accepted } = await reader.until(buffer => socks5.authAccepted(buffer));
    reader.consume(2);
    if (!accepted) return failed('auth', 'the browser proxy refused the username and password');
  }
  const connect = socks5.connectRequest(destination);
  if (connect === undefined) return failed('other', 'that address cannot be sent through a SOCKS5 proxy');
  socket.write(connect);
  const { result } = await reader.until(buffer => {
    const reply = socks5.connectReply(buffer);
    return reply.state === 'incomplete' ? undefined : reply;
  });
  if (result.state === 'failed')
    return failed('proxy', `the browser proxy could not open the connection: ${result.why}`);
  reader.consume(result.length);
  return { leftover: reader.release() };
}
