import { isIP, type Socket } from 'node:net';
import type { Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { connect as tlsConnect } from 'node:tls';
import {
  classifyNetworkError,
  PROBE_DESTINATION,
  type ProbeFailure,
  type ProbeOutcome,
  type ProxyEndpoint,
  type ProxyProbe,
  parseProbeReply,
} from '../index.ts';
import { openTunnel, type ProxyCredentials } from './tunnel.ts';
import type { ProxyExit } from '../../worker/control/policy.ts';

/** The one HTTPS endpoint that says where an address is: asked only to set a stealth identity's time zone and language. */
const LOCATE_DESTINATION = { host: 'ipinfo.io', port: 443 } as const;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/u;
const COUNTRY = /^[A-Z]{2}$/u;

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
  constructor(
    private readonly options: {
      /** The kernel clock the whole probe's deadline runs on. */
      readonly clock: Pick<Clock, 'after'>;
      readonly timeoutMs?: number;
      readonly secure?: SecureUpgrade;
    },
  ) {}

  async run(request: {
    readonly endpoint: ProxyEndpoint;
    readonly credentials?: ProxyCredentials;
  }): Promise<ProbeOutcome> {
    const timeoutMs = this.options.timeoutMs ?? PROBE_TIMEOUT_MS;
    const sockets = new Set<Socket>();
    let cancel: (() => void) | undefined;
    const deadline = new Promise<ProbeOutcome>(resolve => {
      cancel = this.options.clock.after(milliseconds(timeoutMs), () => {
        for (const socket of sockets) socket.destroy();
        resolve({ ok: false, errorClass: 'timeout' });
      });
    });
    try {
      return await Promise.race([deadline, this.attempt(request, timeoutMs, sockets)]);
    } finally {
      cancel?.();
      for (const socket of sockets) socket.destroy();
    }
  }

  /**
   * Where the proxy's exit is (country and time zone), asked of {@link LOCATE_DESTINATION} through the same proxy and
   * under the same deadline. `undefined` for every failure, an answer that is not a country and a zone, and a
   * zone the host's own tables do not know: the caller then leaves the machine's own zone and language, never a guess.
   */
  async locate(request: {
    readonly endpoint: ProxyEndpoint;
    readonly credentials?: ProxyCredentials;
  }): Promise<ProxyExit | undefined> {
    const timeoutMs = this.options.timeoutMs ?? PROBE_TIMEOUT_MS;
    const sockets = new Set<Socket>();
    let cancel: (() => void) | undefined;
    const deadline = new Promise<undefined>(resolve => {
      cancel = this.options.clock.after(milliseconds(timeoutMs), () => {
        for (const socket of sockets) socket.destroy();
        resolve(undefined);
      });
    });
    try {
      const answer = await Promise.race([
        deadline,
        this.read(request, LOCATE_DESTINATION, '/json', timeoutMs, sockets),
      ]);
      if (answer === undefined || !answer.ok) return undefined;
      const parsed: unknown = JSON.parse(answer.body);
      const { country, timezone } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >;
      if (typeof country !== 'string' || typeof timezone !== 'string') return undefined;
      if (!COUNTRY.test(country) || !TIME_ZONE.test(timezone)) return undefined;
      new Intl.DateTimeFormat('en', { timeZone: timezone });
      return { country, timezone };
    } catch {
      return undefined;
    } finally {
      cancel?.();
      for (const socket of sockets) socket.destroy();
    }
  }

  private async attempt(
    request: { readonly endpoint: ProxyEndpoint; readonly credentials?: ProxyCredentials },
    timeoutMs: number,
    sockets: Set<Socket>,
  ): Promise<ProbeOutcome> {
    const read = await this.read(request, PROBE_DESTINATION, '/', timeoutMs, sockets);
    if (!read.ok) return read;
    return isIP(read.body) === 0 ? { ok: false, errorClass: 'other' } : { ok: true, egressIp: read.body };
  }

  /** One GET to `destination` through the proxy; the body of a 200, or the class of what went wrong. */
  private async read(
    request: { readonly endpoint: ProxyEndpoint; readonly credentials?: ProxyCredentials },
    destination: { readonly host: string; readonly port: number },
    path: string,
    timeoutMs: number,
    sockets: Set<Socket>,
  ): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly errorClass: ProbeFailure }> {
    const tunnel = await openTunnel({
      upstream: request.endpoint,
      ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
      destination,
      connectTimeoutMs: timeoutMs,
      track: socket => sockets.add(socket),
    });
    if (!tunnel.ok) return { ok: false, errorClass: tunnel.errorClass };
    const secured = (this.options.secure ?? verifiedTls)(tunnel.socket, destination.host);
    sockets.add(secured);
    try {
      const parsed = parseProbeReply(await ask(secured, destination.host, path));
      if (parsed === undefined || parsed.status !== 200) return { ok: false, errorClass: 'other' };
      return { ok: true, body: parsed.body };
    } catch (error) {
      const errorClass: ProbeFailure = classifyNetworkError(error);
      return { ok: false, errorClass: errorClass === 'other' ? 'tls' : errorClass };
    }
  }
}

/** Sends the one request and reads until the endpoint closes, within a small cap. */
function ask(socket: Socket, host: string, path: string): Promise<string> {
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
    socket.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}
