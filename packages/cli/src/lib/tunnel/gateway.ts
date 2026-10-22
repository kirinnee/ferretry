import { TUNNEL_PATH, TunnelChangeSchema, type TunnelStatusView, TunnelStatusViewSchema } from '@ferretry/protocol';
import type { ITunnelGateway, TunnelApiClient } from './ports.ts';

/** Speaks `/v1/tunnel` through the protocol client, parsing both directions rather than casting. */
export class ProtocolTunnelGateway implements ITunnelGateway {
  constructor(private readonly client: TunnelApiClient) {}

  async read(): Promise<TunnelStatusView> {
    return await this.client.request(TUNNEL_PATH, TunnelStatusViewSchema);
  }

  async change(enabled: boolean): Promise<TunnelStatusView> {
    return await this.client.request(TUNNEL_PATH, TunnelStatusViewSchema, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TunnelChangeSchema.parse({ enabled })),
    });
  }
}

/**
 * The tunnel line `fy daemon status` adds: the daemon's own view, or nothing.
 *
 * NOTHING, RATHER THAN A FAILURE, for every reason the read can fail — a daemon older than the route
 * answers `404`, and one that stopped between the health probe and this read does not answer — because
 * `status` is reporting on the daemon, and its exit code is the daemon's, never this line's.
 */
export class ProtocolTunnelStatusReader {
  constructor(
    private readonly client: TunnelApiClient,
    private readonly timeoutMs = 3_000,
  ) {}

  async read(): Promise<TunnelStatusView | undefined> {
    try {
      return await this.client.request(TUNNEL_PATH, TunnelStatusViewSchema, undefined, this.timeoutMs);
    } catch {
      return undefined;
    }
  }
}
