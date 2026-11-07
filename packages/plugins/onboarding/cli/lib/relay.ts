import { DaemonCarriersViewSchema } from '@ferretry/protocol';
import type { CarrierApiClient, IOnboardRelay, RelayReach } from './ports.ts';

/** The daemon's published carrier set (`docs/relay-protocol.md` §13). */
export const CARRIERS_PATH = '/v1/carriers';

/**
 * Whether a phone on another network can reach this daemon, asked of the DAEMON.
 *
 * The daemon is the end that discovered the hosted relay at boot, so its published set is the answer;
 * `fy` asking the relay directory itself would be a second discovery that could disagree with the one
 * that matters, and would put a local command on the network. A set with a `relay` entry is reachable
 * from anywhere; a set without one is direct-only — still fine for a phone on the same network.
 */
export class ProtocolOnboardRelay implements IOnboardRelay {
  constructor(private readonly client: CarrierApiClient) {}

  async reach(): Promise<RelayReach> {
    try {
      const view = await this.client.request(CARRIERS_PATH, DaemonCarriersViewSchema);
      const relay = view.carriers.find(carrier => carrier.kind === 'relay');
      return relay === undefined ? { state: 'direct-only' } : { state: 'relay', url: relay.url };
    } catch (error: unknown) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
