import { describe, expect, test } from 'bun:test';
import { connectionsConformance, fakeConnections } from '../../contract/testing/index.ts';
import {
  connectionsLoosens,
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
