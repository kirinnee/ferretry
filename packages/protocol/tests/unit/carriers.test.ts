import { describe, expect, it } from 'bun:test';
import {
  DaemonCarrierSchema,
  DaemonCarriersViewSchema,
  DaemonOriginSchema,
  KNOWN_CARRIER_KINDS,
  MAX_PUBLISHED_CARRIERS,
  PublishedCarriersSchema,
  SocketEndpointSchema,
  TunnelOriginSchema,
} from '@ferretry/protocol';

describe('published daemon carriers', () => {
  it('normalizes dialable relay endpoints without weakening transport security', () => {
    expect(SocketEndpointSchema.parse('https://relay.example/')).toBe('https://relay.example');
    expect(SocketEndpointSchema.parse('wss://relay.example')).toBe('wss://relay.example');
    expect(SocketEndpointSchema.parse('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(SocketEndpointSchema.parse('ws://[::1]:8787')).toBe('ws://[::1]:8787');
    expect(SocketEndpointSchema.safeParse('http://relay.example').success).toBe(false);
    expect(SocketEndpointSchema.safeParse('ftp://relay.example').success).toBe(false);
    expect(SocketEndpointSchema.safeParse('not a URL').success).toBe(false);
    expect(SocketEndpointSchema.safeParse('https://relay.example?token=nope').success).toBe(false);
    expect(SocketEndpointSchema.safeParse('https://relay.example#fingerprint').success).toBe(false);
  });

  it('holds a direct daemon address to the origin rule its readers already apply', () => {
    // Plain HTTP is the ordinary private-network deployment and must stay publishable.
    expect(DaemonOriginSchema.parse('http://box.lan:7431')).toBe('http://box.lan:7431');
    expect(DaemonOriginSchema.parse('https://box.example/')).toBe('https://box.example');
    expect(DaemonOriginSchema.parse('http://127.0.0.1:7431/')).toBe('http://127.0.0.1:7431');
    // Everything `daemonBaseUrl` and the CLI's pairing-link check refuse, refused here first.
    expect(DaemonOriginSchema.safeParse('ftp://box.example').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('wss://box.example').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('https://user:pw@box.example').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('https://box.example/behind/a/proxy').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('https://box.example/?token=nope').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('https://box.example/#fingerprint').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('box.example:7431').success).toBe(false);
    expect(DaemonOriginSchema.safeParse('not a URL').success).toBe(false);
  });

  it('holds a tunnel to a bare, non-loopback https origin', () => {
    expect(TunnelOriginSchema.parse('https://abc.tunnels.example.com/')).toBe('https://abc.tunnels.example.com');
    expect(DaemonCarrierSchema.parse({ kind: 'tunnel', url: 'https://abc.tunnels.example.com' })).toEqual({
      kind: 'tunnel',
      url: 'https://abc.tunnels.example.com',
    });
    expect(TunnelOriginSchema.safeParse('http://abc.tunnels.example.com').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('wss://abc.tunnels.example.com').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://127.0.0.1').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://localhost').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://abc.example.com/path').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://user:pw@abc.example.com').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('https://abc.example.com?x=1').success).toBe(false);
    expect(TunnelOriginSchema.safeParse('not a URL').success).toBe(false);
  });

  it('skips a carrier kind this build does not know instead of refusing the set', () => {
    const set = PublishedCarriersSchema.parse([
      { kind: 'direct', url: 'http://box.lan:7431' },
      { kind: 'teleport', url: 'https://future.example' },
      { kind: 'tunnel', url: 'https://abc.tunnels.example.com' },
    ]);
    expect(set).toEqual([
      { kind: 'direct', url: 'http://box.lan:7431' },
      { kind: 'tunnel', url: 'https://abc.tunnels.example.com' },
    ]);
    expect(KNOWN_CARRIER_KINDS.has('tunnel')).toBe(true);
    // A KNOWN kind breaking its own rule is still refused, and so is an entry with no usable kind.
    expect(PublishedCarriersSchema.safeParse([{ kind: 'tunnel', url: 'http://abc.example.com' }]).success).toBe(false);
    expect(PublishedCarriersSchema.safeParse([{ kind: 7, url: 'https://abc.example.com' }]).success).toBe(false);
    expect(PublishedCarriersSchema.safeParse(['nope']).success).toBe(false);
    expect(PublishedCarriersSchema.safeParse([null]).success).toBe(false);
    expect(PublishedCarriersSchema.safeParse('nope').success).toBe(false);
    const tooMany = Array.from({ length: MAX_PUBLISHED_CARRIERS + 1 }, () => ({ kind: 'teleport', url: 'x' }));
    expect(PublishedCarriersSchema.safeParse(tooMany).success).toBe(false);
  });

  it('keeps direct and relay carriers as a strict discriminated union', () => {
    expect(DaemonCarrierSchema.parse({ kind: 'direct', url: 'http://box.lan:7431' })).toEqual({
      kind: 'direct',
      url: 'http://box.lan:7431',
    });
    expect(DaemonCarrierSchema.parse({ kind: 'direct', url: 'https://box.example/' })).toEqual({
      kind: 'direct',
      url: 'https://box.example',
    });
    expect(DaemonCarrierSchema.safeParse({ kind: 'direct', url: 'https://box.example/proxied' }).success).toBe(false);
    expect(DaemonCarrierSchema.safeParse({ kind: 'direct', url: 'https://user:pw@box.example' }).success).toBe(false);
    expect(DaemonCarrierSchema.safeParse({ kind: 'direct', url: 'ftp://box.example' }).success).toBe(false);
    expect(DaemonCarrierSchema.parse({ kind: 'relay', url: 'https://relay.example/' })).toEqual({
      kind: 'relay',
      url: 'https://relay.example',
    });
    expect(DaemonCarrierSchema.safeParse({ kind: 'relay', url: 'https://relay.example', local: true }).success).toBe(
      false,
    );
    expect(DaemonCarrierSchema.safeParse({ kind: 'bind', url: 'https://box.example' }).success).toBe(false);
  });

  it('bounds the published walk and wraps the refresh response', () => {
    const carriers = Array.from({ length: MAX_PUBLISHED_CARRIERS }, (_, index) => ({
      kind: 'direct' as const,
      url: `https://box-${String(index)}.example`,
    }));
    expect(PublishedCarriersSchema.parse(carriers)).toEqual(carriers);
    expect(
      PublishedCarriersSchema.safeParse([...carriers, { kind: 'direct', url: 'https://one-too-many.example' }]).success,
    ).toBe(false);
    expect(DaemonCarriersViewSchema.parse({ carriers })).toEqual({ carriers });
    expect(DaemonCarriersViewSchema.safeParse({ carriers, daemonId: 'not-published-here' }).success).toBe(false);
  });
});
