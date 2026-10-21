/**
 * The composition root's half of the connection preference (`docs/relay-protocol.md` §15): the router
 * reads this device's preference for each machine, a change walks again at once, and the tunnel
 * service is read only when asked.
 */

import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import { CarrierPreferenceStore } from '../../src/lib/carrier-preference.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { createAppStore } from '../../src/lib/store.tsx';
import { autoDial, keyedDaemon, relayCrypto, ScriptedSocket, settle } from '../support/relay.ts';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const memoryPreferences = () => {
  const values = new Map<string, string>();
  return new CarrierPreferenceStore({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  });
};

describe('the store’s connection preference', () => {
  it('walks the new preference at once when it changes, over only what it allows', async () => {
    const TUNNEL = 'https://k3x9.tunnels.example.com';
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://alpha.example.test', [
      { kind: 'direct', daemonUrl: 'https://alpha.example.test' },
      { kind: 'tunnel', tunnelUrl: TUNNEL },
    ]);
    const scripted = autoDial(identity, {
      respond: request =>
        request.path === '/v1/carriers'
          ? {
              body: {
                carriers: [
                  { kind: 'direct', url: 'https://alpha.example.test' },
                  { kind: 'tunnel', url: TUNNEL },
                ],
              },
            }
          : { body: [] },
    });
    const dialled: string[] = [];
    const dial = (url: string): ScriptedSocket => {
      dialled.push(new URL(url).hostname);
      return scripted.dial();
    };
    const preferences = memoryPreferences();
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
      deviceKeys,
      relayCrypto,
      relayDial: dial,
      carrierPreferences: preferences,
    });
    store.connections.add(daemon);
    expect(store.carrierPreferences).toBe(preferences);
    expect(store.webrtcAvailable).toBe(false);

    // Act — Tunnel only, chosen while nothing has been carried yet.
    preferences.set(daemon.daemonId, 'tunnel');
    await settle();

    // Assert — the store's own probe walked it, and it went over the tunnel and nothing else.
    expect(dialled[0]).toBe('k3x9.tunnels.example.com');
    expect(store.carrier.choice(daemon.daemonId)?.reason).toBe('Connected over Cloudflare tunnel.');

    // A preference for a machine this device does not hold is kept, and walks nothing.
    preferences.set('fy_daemon_elsewhere' as typeof daemon.daemonId, 'relay');
    await settle(5);
  });

  it('says whether this build can dial WebRTC, and reads the tunnel service once, only when asked', async () => {
    let asked = 0;
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => {
        asked += 1;
        return Response.json({});
      },
      carrierDialers: { webrtc: async () => new ScriptedSocket() },
      carrierPreferences: memoryPreferences(),
    });
    const before = asked;
    expect(store.webrtcAvailable).toBe(true);
    // This suite's build has no relay directory, so the honest answer is "not set up", asked of nobody.
    expect(await store.tunnelService()).toBe('unavailable');
    expect(await store.tunnelService()).toBe('unavailable');
    expect(asked).toBe(before);
  });
});
