import { describe, expect, it } from 'bun:test';
import {
  ConfiguredRelayCarrierSchema,
  DaemonCarriersDocumentSchema,
  DISCOVERED_RELAY_CARRIER,
  MAX_RELAY_CARRIERS,
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
    });
    expect(
      resolveDaemonCarriers({
        ...legacy,
        carriers: [{ kind: 'bind', host: 'box.lan' }],
      }),
    ).toEqual({
      bind: { kind: 'bind', host: 'box.lan' },
      relays: [DISCOVERED_RELAY_CARRIER],
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
});
