import { describe, expect, it } from 'bun:test';
import {
  ConfiguredRelayCarrierSchema,
  DaemonCarriersDocumentSchema,
  DISCOVERED_RELAY_CARRIER,
  declaresTunnelCarrier,
  IMPLIED_TUNNEL_CARRIER,
  MAX_RELAY_CARRIERS,
  MAX_TUNNEL_CARRIERS,
  relayCarrierIsConfigured,
  resolveDaemonCarriers,
  supersededCarrierKeys,
} from '../../../src/lib/runtime/carriers.ts';

const legacy = {
  host: '127.0.0.1',
  port: 7431,
  relay: undefined,
  carriers: [],
} as const;

describe('daemon carrier configuration', () => {
  it('normalizes the legacy bind and hosted fallback into ordinary entries', () => {
    expect(resolveDaemonCarriers(legacy)).toEqual({
      bind: { kind: 'bind', host: '127.0.0.1', port: 7431 },
      relays: [DISCOVERED_RELAY_CARRIER],
      tunnel: IMPLIED_TUNNEL_CARRIER,
    });
    expect(relayCarrierIsConfigured(DISCOVERED_RELAY_CARRIER)).toBe(false);
  });

  it('normalizes a legacy configured relay with the same defaults as a new entry', () => {
    const resolved = resolveDaemonCarriers({
      ...legacy,
      relay: { url: 'https://relay.example', enabled: false, reconnectSeconds: 45 },
    });
    expect(resolved.relays).toEqual([
      { kind: 'relay', url: 'https://relay.example', enabled: false, reconnectSeconds: 45 },
    ]);
    expect(relayCarrierIsConfigured(resolved.relays[0] as (typeof resolved.relays)[number])).toBe(true);
  });

  it('lets the new spelling win independently for bind and relay kinds', () => {
    const configuredRelay = ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'wss://new.example' });
    expect(
      resolveDaemonCarriers({
        ...legacy,
        relay: { url: 'wss://legacy.example', enabled: true, reconnectSeconds: 5 },
        carriers: [configuredRelay],
      }),
    ).toEqual({
      bind: { kind: 'bind', host: '127.0.0.1', port: 7431 },
      relays: [{ kind: 'relay', url: 'wss://new.example', enabled: true, reconnectSeconds: 5 }],
      tunnel: IMPLIED_TUNNEL_CARRIER,
    });
    expect(
      resolveDaemonCarriers({
        ...legacy,
        carriers: [{ kind: 'bind', host: 'box.lan' }],
      }),
    ).toEqual({
      bind: { kind: 'bind', host: 'box.lan' },
      relays: [DISCOVERED_RELAY_CARRIER],
      tunnel: IMPLIED_TUNNEL_CARRIER,
    });
  });

  it('reports every legacy key superseded by an explicit carrier kind', () => {
    expect(
      supersededCarrierKeys({
        rawDocument: { host: 'box.lan', port: 7431, relay: { url: 'https://old.example' } },
        carriers: [
          { kind: 'bind', host: 'box.lan' },
          ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://new.example' }),
        ],
      }),
    ).toEqual(['host', 'port', 'relay']);
    expect(supersededCarrierKeys({ rawDocument: { host: '127.0.0.1', port: 7431 }, carriers: [] })).toEqual([]);
  });

  it('never claims a legacy key the operator did not write', () => {
    const carriers = [
      { kind: 'bind', host: 'box.lan' },
      ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://new.example' }),
    ] as const;

    // `host` carries a schema default, so a PARSED document always has one. Reading the parsed value
    // would send somebody who wrote only `carriers` looking for keys that are not in their file.
    expect(supersededCarrierKeys({ rawDocument: {}, carriers })).toEqual([]);
    // Half a migration: only `port` was ever written, so only `port` is named.
    expect(supersededCarrierKeys({ rawDocument: { port: 7431 }, carriers })).toEqual(['port']);
    expect(supersededCarrierKeys({ rawDocument: { host: 'box.lan' }, carriers })).toEqual(['host']);
    // Written but null is still written: the key is in the file and it is doing nothing.
    expect(supersededCarrierKeys({ rawDocument: { relay: null }, carriers })).toEqual(['relay']);
    // A key is only superseded by a carrier of its OWN kind — the bind keys survive a relay-only list.
    expect(
      supersededCarrierKeys({
        rawDocument: { host: 'box.lan', port: 7431, relay: { url: 'https://old.example' } },
        carriers: [ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://new.example' })],
      }),
    ).toEqual(['relay']);
    expect(
      supersededCarrierKeys({
        rawDocument: { host: 'box.lan', port: 7431, relay: { url: 'https://old.example' } },
        carriers: [{ kind: 'bind', host: 'box.lan' }],
      }),
    ).toEqual(['host', 'port']);
  });

  it('refuses more than one listener, more than four relays, and duplicate rendezvous entries', () => {
    expect(
      DaemonCarriersDocumentSchema.safeParse([
        { kind: 'bind', host: '127.0.0.1' },
        { kind: 'bind', host: 'box.lan' },
      ]).success,
    ).toBe(false);
    expect(
      DaemonCarriersDocumentSchema.safeParse(
        Array.from({ length: MAX_RELAY_CARRIERS + 1 }, (_, index) => ({
          kind: 'relay',
          url: `https://relay-${String(index)}.example`,
        })),
      ).success,
    ).toBe(false);
    expect(
      DaemonCarriersDocumentSchema.safeParse([
        { kind: 'relay', source: 'discovery' },
        { kind: 'relay', source: 'discovery', enabled: false },
      ]).success,
    ).toBe(false);
    expect(
      DaemonCarriersDocumentSchema.safeParse([
        { kind: 'relay', url: 'https://relay.example' },
        { kind: 'relay', url: 'https://relay.example/' },
      ]).success,
    ).toBe(false);
  });

  it('implies NO tunnel, and lets an explicit entry switch it on or off', () => {
    // Nothing declared: the tunnel is opt-in, so the implied entry is off — unlike the hosted relay.
    expect(resolveDaemonCarriers(legacy).tunnel).toEqual(IMPLIED_TUNNEL_CARRIER);
    expect(IMPLIED_TUNNEL_CARRIER).toEqual({ kind: 'tunnel', source: 'discovery', enabled: false });
    expect(declaresTunnelCarrier(legacy.carriers)).toBe(false);
    // An entry with no `enabled` key is ON: writing the entry is the decision.
    const on = DaemonCarriersDocumentSchema.parse([{ kind: 'tunnel', source: 'discovery' }]);
    expect(resolveDaemonCarriers({ ...legacy, carriers: on }).tunnel).toEqual({
      kind: 'tunnel',
      source: 'discovery',
      enabled: true,
    });
    expect(declaresTunnelCarrier(on)).toBe(true);
    // "No tunnel, and I mean it" is a decision written down, and it wins.
    const off = DaemonCarriersDocumentSchema.parse([{ kind: 'tunnel', source: 'discovery', enabled: false }]);
    expect(resolveDaemonCarriers({ ...legacy, carriers: off }).tunnel).toEqual({
      kind: 'tunnel',
      source: 'discovery',
      enabled: false,
    });
    expect(declaresTunnelCarrier(off)).toBe(true);
    // A tunnel entry is neither a bind nor a relay: the legacy relay is still read beside it.
    const resolved = resolveDaemonCarriers({
      ...legacy,
      relay: { url: 'wss://legacy.example', enabled: true, reconnectSeconds: 5 },
      carriers: off,
    });
    expect(resolved.relays).toEqual([
      { kind: 'relay', url: 'wss://legacy.example', enabled: true, reconnectSeconds: 5 },
    ]);
  });

  it('refuses a second tunnel, and a tunnel with an address of its own', () => {
    expect(MAX_TUNNEL_CARRIERS).toBe(1);
    const twice = DaemonCarriersDocumentSchema.safeParse([
      { kind: 'tunnel', source: 'discovery' },
      { kind: 'tunnel', source: 'discovery', enabled: false },
    ]);
    expect(twice.success).toBe(false);
    expect(twice.error?.issues.map(issue => issue.message)).toEqual([
      'the hosted service provisions one tunnel per daemon, so at most 1 "tunnel" carrier may be declared',
    ]);
    // There is nothing an operator could write down instead of discovery.
    expect(DaemonCarriersDocumentSchema.safeParse([{ kind: 'tunnel', url: 'https://box.example' }]).success).toBe(
      false,
    );
    // Four relays beside a tunnel are still within the relay bound: kinds are counted on their own.
    expect(
      DaemonCarriersDocumentSchema.safeParse([
        { kind: 'tunnel', source: 'discovery' },
        ...Array.from({ length: MAX_RELAY_CARRIERS }, (_, index) => ({
          kind: 'relay',
          url: `https://relay-${String(index)}.example`,
        })),
      ]).success,
    ).toBe(true);
  });
});
