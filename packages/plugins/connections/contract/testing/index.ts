/** `@ferretry/plugin-connections/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import {
  type ConnectionsApi,
  type ConnectionAdvertisement,
  type PublishedCarriers,
  PublishedCarriersSchema,
  type TunnelStatusView,
  TunnelStatusViewSchema,
} from '../index.ts';

const TUNNEL_OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: 'Tunnel: off (opt-in)',
};

/** An in-memory `ConnectionsApi` whose carrier set a test may change. */
export function fakeConnections(
  initial: PublishedCarriers = [],
  tunnel: TunnelStatusView = TUNNEL_OFF,
  advertisement: ConnectionAdvertisement = { advertisement: { kind: 'none', refusal: 'no-port' } },
): ConnectionsApi & { set(carriers: PublishedCarriers): void } {
  let carriers = PublishedCarriersSchema.parse(initial);
  return {
    set: next => {
      carriers = PublishedCarriersSchema.parse(next);
    },
    carriers: () => carriers,
    advertisement: () => advertisement,
    tunnel: async () => TunnelStatusViewSchema.parse(tunnel),
  };
}

/** What every `ConnectionsApi` keeps. */
export function connectionsConformance(name: string, make: () => ConnectionsApi): void {
  describe(`ConnectionsApi conformance: ${name}`, () => {
    test('the published carriers parse as the wire view and publish no WebRTC entry', () => {
      const carriers = make().carriers();
      expect(PublishedCarriersSchema.safeParse(carriers).success).toBe(true);
      expect(carriers.some(carrier => (carrier.kind as string) === 'webrtc')).toBe(false);
    });
    test('the tunnel status parses as the wire view', async () => {
      expect(TunnelStatusViewSchema.safeParse(await make().tunnel()).success).toBe(true);
    });
  });
}
