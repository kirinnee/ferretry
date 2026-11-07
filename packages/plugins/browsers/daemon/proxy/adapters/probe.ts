import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  classifyNetworkError,
  PROBE_DESTINATION,
  type ProbeFailure,
  type ProbeOutcome,
  type ProxyEndpoint,
  type ProxyProbe,
  parseProbeReply,
} from '../../../lib/browser/proxy/index.ts';
import { openTunnel, type ProxyCredentials } from './tunnel.ts';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 8 * 1024;

/** Puts TLS on a tunnel to `host`. Tests swap this for a pass-through because a loopback fake has no certificate. */
export type SecureUpgrade = (tunnel: Socket, host: string) => Socket;

const verifiedTls: SecureUpgrade = (tunnel, host) => tlsConnect({ socket: tunnel, servername: host });

/**
 * Asks the neutral test endpoint for the address it sees, through the proxy, over one tunnel that is closed as soon
 * as the answer is in. The whole attempt shares one deadline, so a proxy that accepts and then says nothing still
 * ends as a timeout.
 */
export class TunnelProxyProbe implements ProxyProbe {
  constructor(private readonly options: { readonly timeoutMs?: number; readonly secure?: SecureUpgrade } = {}) {}

  async run(request: {
    readonly endpoint: ProxyEndpoint;
    readonly credentials?: ProxyCredentials;
  }): Promise<ProbeOutcome> {
    const timeoutMs = this.options.timeoutMs ?? PROBE_TIMEOUT_MS;
    const sockets = new Set<Socket>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ProbeOutcome>(resolve => {
      timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        resolve({ ok: false, errorClass: 'timeout' });
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, this.attempt(request, timeoutMs, sockets)]);
    } finally {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
    }
  }

  private async attempt(
    request: { readonly endpoint: ProxyEndpoint; readonly credentials?: ProxyCredentials },
    timeoutMs: number,
    sockets: Set<Socket>,
  ): Promise<ProbeOutcome> {
    const tunnel = await openTunnel({
      upstream: request.endpoint,
      ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
      destination: PROBE_DESTINATION,
      connectTimeoutMs: timeoutMs,
      track: socket => sockets.add(socket),
    });
    if (!tunnel.ok) return { ok: false, errorClass: tunnel.errorClass };
    const secured = (this.options.secure ?? verifiedTls)(tunnel.socket, PROBE_DESTINATION.host);
    sockets.add(secured);
    try {
      const reply = await ask(secured);
      const parsed = parseProbeReply(reply);
      if (parsed === undefined || parsed.status !== 200 || isIP(parsed.body) === 0)
        return { ok: false, errorClass: 'other' };
      return { ok: true, egressIp: parsed.body };
    } catch (error) {
      const errorClass: ProbeFailure = classifyNetworkError(error);
      return { ok: false, errorClass: errorClass === 'other' ? 'tls' : errorClass };
    }
  }
}

/** Sends the one request and reads until the endpoint closes, within a small cap. */
function ask(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_REPLY_BYTES) socket.destroy();
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.write(
      `GET / HTTP/1.0\r\nHost: ${PROBE_DESTINATION.host}\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`,
    );
  });
}
