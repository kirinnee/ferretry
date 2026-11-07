import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('connections manifest', () => {
  test("declares today's carrier, tunnel and WebRTC routes and the direct carrier's socket", () => {
    expect(manifest.actions.routes.map(route => route.key).sort()).toEqual([
      'GET /v1/carriers',
      'GET /v1/tunnel',
      'POST /v1/webrtc/offer',
      'PUT /v1/tunnel',
    ]);
    expect(manifest.actions.sockets.map(socket => socket.key)).toEqual(['GET /v1/rendezvous/:daemonId/client']);
  });
  test('the published carriers are never stored by a client: freshness is the whole value', () => {
    expect(manifest.actions.routes.find(route => route.key === 'GET /v1/carriers')?.noStore).toBe(true);
  });
  test('switching the tunnel is a person act on pairing.configure, kept as a security change', () => {
    const put = manifest.actions.routes.find(route => route.key === 'PUT /v1/tunnel');
    expect(put?.caller).toBe('person');
    expect(put?.capability?.axis).toBe('configure');
    expect(put?.audit).toHaveProperty('record');
  });
  test('takes exactly the four carrier keys', () => {
    expect(manifest.hooks.takes.flatMap(take => ('key' in take ? [take.key] : []))).toEqual([
      'direct',
      'relay',
      'tunnel',
      'webrtc',
    ]);
    expect(manifest.hooks.takes.some(take => take.hook.name === 'doctor.checks')).toBe(true);
  });
});
