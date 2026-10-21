/**
 * ONE HTTP READ, ONCE PER BOOT: does Ferretry's hosted service provision tunnels today?
 *
 * `GET <hosted origin>/v1/tunnel-service`, from the same origin the relay advertisement is read from,
 * `no-store` because `available: false` is the operator's switch and a cached `true` would be that
 * switch not working. It never throws and never retries: every failure is one `unavailable` sentence,
 * and the boot carries on without a tunnel and says so.
 */

import {
  NO_TUNNEL_SERVICE,
  parseTunnelServiceAdvertisement,
  TUNNEL_SERVICE_TIMEOUT_MS,
  type TunnelServiceAvailability,
  tunnelServiceAddress,
  tunnelServiceOrigin,
  type TunnelServicePort,
} from '../../lib/tunnel/index.ts';

/** The narrow slice of `fetch` these reads need, injected so no suite dials out. */
export type TunnelServiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedTunnelServiceOptions {
  readonly fetcher?: TunnelServiceFetch;
  readonly timeoutMs?: number;
}

export class HostedTunnelService implements TunnelServicePort {
  private readonly fetcher: TunnelServiceFetch;
  private readonly timeoutMs: number;

  /** @param origin The discovery origin this build carries, or `undefined` when it carries none. */
  constructor(
    private readonly origin: string | undefined,
    options: HostedTunnelServiceOptions = {},
  ) {
    // Wrapped rather than stored bare: a builtin kept as a value takes its holder as the receiver.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TUNNEL_SERVICE_TIMEOUT_MS;
  }

  async read(): Promise<TunnelServiceAvailability> {
    if (this.origin === undefined) return NO_TUNNEL_SERVICE;
    const origin = tunnelServiceOrigin(this.origin);
    if (origin === undefined)
      return { kind: 'unavailable', reason: 'the configured hosted service is not an address this daemon may ask' };
    let response: Response;
    try {
      response = await this.fetcher(tunnelServiceAddress(origin), {
        cache: 'no-store',
        // The answer is about THIS origin; a redirect is another service answering for it.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'unavailable', reason: 'this daemon could not reach the hosted tunnel service' };
    }
    if (!response.ok)
      return { kind: 'unavailable', reason: `the hosted tunnel service answered ${String(response.status)}` };
    try {
      return parseTunnelServiceAdvertisement(origin, await response.json());
    } catch {
      return { kind: 'unavailable', reason: 'the hosted tunnel service answered something that is not a document' };
    }
  }
}
