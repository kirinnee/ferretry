import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  test('R225 first run has no carrier chooser: Connections offers a machine tab and a status panel, nothing on the onboarding rail', () => {
    // What Connections contributes to any screen: one settings tab (a machine already paired), one status panel and a device-level Connection panel.
    expect(manifest.ui.settings).toHaveLength(1);
    expect(manifest.ui.settings[0]).toMatchObject({ id: 'connection' });
    // The status panel, and this device's own Connection panel (device settings: no machine needed to change the carrier).
    expect(manifest.ui.panels.map(panel => `${panel.slot}:${panel.id}`)).toEqual([
      'daemon.status:carrier',
      'device.settings:connection',
    ]);
    expect(JSON.stringify(manifest.ui)).not.toMatch(/onboarding|first-run|setup/iu);
    // And the first-run screen, in the package that owns it, never mounts the chooser: it states the carrier order.
    const onboarding = join(import.meta.dir, '..', '..', '..', 'onboarding', 'app');
    const sources = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: onboarding })].map(path =>
      readFileSync(join(onboarding, path), 'utf8'),
    );
    expect(sources.length).toBeGreaterThan(3);
    for (const source of sources) {
      expect(source).not.toContain('CarrierPreferenceSelector');
      expect(source).not.toContain('carrier-preference');
    }
  });
});
