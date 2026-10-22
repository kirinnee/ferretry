import { describe, it } from 'bun:test';
import should from 'should';
import * as protocol from '../../src/lib/index.ts';
import * as tunnel from '../../src/lib/tunnel.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const off = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: tunnel.TUNNEL_OFF_SENTENCE,
};

const up = {
  enabled: true,
  explicit: true,
  state: 'up',
  tunnelUrl: 'https://abc.ferretry.stream',
  sentence: 'Tunnel: up — https://abc.ferretry.stream',
};

const tunnelCases: SchemaCase[] = [
  { name: 'a state', schema: tunnel.TunnelStateSchema, value: 'connecting' },
  { name: 'the opt-in default', schema: tunnel.TunnelStatusViewSchema, value: off },
  { name: 'a published tunnel', schema: tunnel.TunnelStatusViewSchema, value: up },
  { name: 'a change', schema: tunnel.TunnelChangeSchema, value: { enabled: true } },
];

describe('the tunnel switch wire', () => {
  it('should round-trip every record and cover every exported schema', () => {
    assertRoundTrips(tunnelCases);
    assertCoversEverySchema(tunnel, tunnelCases);
  });

  it('should name the five states in the order a tunnel moves through them', () => {
    should([...tunnel.TunnelStateSchema.options]).deepEqual(['off', 'unavailable', 'provisioning', 'connecting', 'up']);
  });

  it('should refuse an unknown state, an extra field and a change that is not a boolean', () => {
    assertRejects([
      { name: 'an unknown state', schema: tunnel.TunnelStateSchema, value: 'paused' },
      { name: 'an extra field', schema: tunnel.TunnelStatusViewSchema, value: { ...off, token: 'x' } },
      { name: 'a missing url', schema: tunnel.TunnelStatusViewSchema, value: { ...off, tunnelUrl: undefined } },
      { name: 'a word for a switch', schema: tunnel.TunnelChangeSchema, value: { enabled: 'on' } },
      { name: 'an empty change', schema: tunnel.TunnelChangeSchema, value: {} },
    ]);
  });

  it('should be exported from the package entry with the route and the off sentence', () => {
    should(protocol.TUNNEL_PATH).equal('/v1/tunnel');
    should(protocol.TUNNEL_OFF_SENTENCE).equal(
      'Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection',
    );
    should(protocol.TunnelStatusViewSchema).equal(tunnel.TunnelStatusViewSchema);
  });
});
