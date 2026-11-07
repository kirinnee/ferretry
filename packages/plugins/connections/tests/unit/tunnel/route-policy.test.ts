import { expect, it } from 'bun:test';
import manifest from '../../../manifest.ts';
import { AUDIT, ConnectionsConfigSchema, WebRtcOfferRequestSchema } from '../../../contract/index.ts';

it('G117 tunnel configuration retains the person-only pairing.configure descriptor', () => {
  const route = manifest.actions.routes.find(route => route.key === 'PUT /v1/tunnel');
  expect(route).toMatchObject({
    minimum: 'operator',
    caller: 'person',
    capability: { capability: 'pairing', axis: 'configure' },
    noStore: true,
  });
});
it('G119 tunnel status is authenticated and ungoverned, and changes declare security.changed audit', () => {
  const get = manifest.actions.routes.find(route => route.key === 'GET /v1/tunnel');
  const put = manifest.actions.routes.find(route => route.key === 'PUT /v1/tunnel');
  expect(get).toMatchObject({ minimum: 'authenticated', noStore: true });
  expect(get).not.toHaveProperty('capability');
  expect(put?.audit).toEqual({ record: AUDIT.securityChanged });
});
it('R672 SDP is a strict object with an exact 32KiB UTF-8 ceiling', () => {
  expect(WebRtcOfferRequestSchema.safeParse({ sdp: 'a'.repeat(32768) }).success).toBe(true);
  expect(WebRtcOfferRequestSchema.safeParse({ sdp: 'é'.repeat(16385) }).success).toBe(false);
  expect(WebRtcOfferRequestSchema.safeParse({ sdp: 'offer', extra: true }).success).toBe(false);
});
it('R673 WebRTC configuration accepts four STUN servers and refuses TURN or a fifth', () => {
  expect(
    ConnectionsConfigSchema.safeParse({ webrtc: { iceServers: Array(4).fill('stun:stun.example:3478') } }).success,
  ).toBe(true);
  expect(ConnectionsConfigSchema.safeParse({ webrtc: { iceServers: ['turn:relay.example'] } }).success).toBe(false);
  expect(
    ConnectionsConfigSchema.safeParse({ webrtc: { iceServers: Array(5).fill('stun:stun.example') } }).success,
  ).toBe(false);
});
