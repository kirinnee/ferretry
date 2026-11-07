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
