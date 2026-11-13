import { describe, expect, test } from 'bun:test';
import { connectionsConformance, fakeConnections } from '../../contract/testing/index.ts';
import {
  connectionsLoosens,
  ConnectionsConfigSchema,
  isLoopbackHost,
  PublishedCarrierSchema,
  SocketEndpointSchema,
  TunnelOriginSchema,
} from '../../contract/index.ts';

connectionsConformance('fakeConnections', () => fakeConnections([{ kind: 'relay', url: 'wss://relay.example.test' }]));

describe('connections wire', () => {
  test('a rendezvous endpoint must be secure unless it is this computer', () => {
    expect(SocketEndpointSchema.safeParse('wss://relay.example.test/').success).toBe(true);
    expect(SocketEndpointSchema.safeParse('ws://relay.example.test').success).toBe(false);
    expect(SocketEndpointSchema.safeParse('ws://127.0.0.1:8787').success).toBe(true);
    expect(SocketEndpointSchema.safeParse('wss://relay.example.test/?token=x').success).toBe(false);
    for (const host of ['127.0.0.2', '127.9.9.9', 'fy.localhost', '[::1]']) {
      expect(SocketEndpointSchema.safeParse(`ws://${host}:8787`).success).toBe(false);
      expect(SocketEndpointSchema.safeParse(`http://${host}:8787`).success).toBe(false);
    }
    expect(SocketEndpointSchema.safeParse('http://localhost:8787').success).toBe(true);
  });
  test('the relay document preserves four ordered entries and refuses a fifth or a duplicate', () => {
    const relay = [
      { url: 'https://one.example' },
      { source: 'discovery' },
      { url: 'https://two.example' },
      { url: 'https://three.example' },
    ];
    const parsed = ConnectionsConfigSchema.parse({ relay });
    expect(parsed.relay?.map(entry => ('url' in entry ? entry.url : entry.source))).toEqual([
      'https://one.example',
      'discovery',
      'https://two.example',
      'https://three.example',
    ]);
    expect(ConnectionsConfigSchema.safeParse({ relay: [...relay, { url: 'https://four.example' }] }).success).toBe(
      false,
    );
    expect(
      ConnectionsConfigSchema.safeParse({ relay: [{ url: 'https://one.example/' }, { url: 'https://one.example' }] })
        .success,
    ).toBe(false);
    expect(
      ConnectionsConfigSchema.safeParse({ relay: [{ source: 'discovery' }, { source: 'discovery', enabled: false }] })
        .success,
    ).toBe(false);
    expect(ConnectionsConfigSchema.safeParse({ relay: { url: 'https://one.example' } }).success).toBe(false);
    expect(ConnectionsConfigSchema.parse({ relay: [] }).relay).toEqual([]);
  });
  test('R171 carriers are a discriminated union of direct, relay and tunnel: one bind, at most four relays', () => {
    // Discriminated on `kind`: each kind admits exactly its own shape, and an unknown kind names nothing.
    for (const carrier of [
      { kind: 'direct', url: 'https://box.example' },
      { kind: 'relay', url: 'wss://relay.example.test' },
      { kind: 'tunnel', url: 'https://quiet.example.test' },
    ])
      expect(PublishedCarrierSchema.safeParse(carrier).success).toBe(true);
    for (const carrier of [
      { kind: 'bind', url: 'https://box.example' },
      { kind: 'direct' },
      { url: 'https://box.example' },
      { kind: 'relay', url: 'wss://relay.example.test', host: 'x' },
    ])
      expect(PublishedCarrierSchema.safeParse(carrier).success).toBe(false);
    // At most one bind: the direct block is ONE object, never a list of binds.
    expect(ConnectionsConfigSchema.safeParse({ direct: { host: '127.0.0.1', port: 7431 } }).success).toBe(true);
    expect(ConnectionsConfigSchema.safeParse({ direct: [{ host: '127.0.0.1' }, { host: '10.0.0.1' }] }).success).toBe(
      false,
    );
    // At most four relays: a fifth entry is refused, never truncated.
    const relays = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://r${String(i)}.example` }));
    expect(ConnectionsConfigSchema.safeParse({ relay: relays(4) }).success).toBe(true);
    expect(ConnectionsConfigSchema.safeParse({ relay: relays(5) }).success).toBe(false);
  });
  test('changing an ordered relay set or enabling one is a loosening', () => {
    const off = ConnectionsConfigSchema.parse({ relay: [{ source: 'discovery', enabled: false }] });
    const on = ConnectionsConfigSchema.parse({ relay: [{ source: 'discovery' }] });
    expect(connectionsLoosens(off, on)).toEqual(['the relay is turned on']);
    expect(connectionsLoosens(on, off)).toEqual([]);
    expect(connectionsLoosens(on, ConnectionsConfigSchema.parse({ relay: [{ url: 'https://mine.example' }] }))).toEqual(
      ['the relay points at a different rendezvous'],
    );
  });
  test('a tunnel is never a loopback address', () => {
    expect(TunnelOriginSchema.safeParse('https://localhost').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://me.example.test').success).toBe(true);
  });
  test('loopback recognises every spelling of this computer', () => {
    for (const host of ['localhost', 'a.localhost', '127.9.9.9', '[::1]', '0:0:0:0:0:0:0:1'])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.test', '10.0.0.1', '::2']) expect(isLoopbackHost(host)).toBe(false);
  });
  test('WebRTC is never a published carrier', () => {
    expect(PublishedCarrierSchema.safeParse({ kind: 'webrtc', url: 'https://x.example.test' }).success).toBe(false);
  });
  test('turning a carrier on is a loosening the owner confirms; turning one off is not', () => {
    expect(connectionsLoosens({ tunnel: { enabled: false } }, { tunnel: { enabled: true } })).toEqual([
      'the tunnel is turned on',
    ]);
    expect(connectionsLoosens({ tunnel: { enabled: true } }, { tunnel: { enabled: false } })).toEqual([]);
  });
});
